import { createServer } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtimeConfig: {} as OpenClawConfig,
  runtimeSourceConfig: null as OpenClawConfig | null,
  ensureBrowserControlAuth: vi.fn(async () => ({ auth: {} })),
  resolveBrowserControlAuth: vi.fn(() => ({})),
  shouldAutoGenerateBrowserAuth: vi.fn(() => false),
  stopKnownBrowserProfiles: vi.fn(async () => {}),
  isChromeReachable: vi.fn(async () => false),
  isChromeCdpReady: vi.fn(async () => false),
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>();
  return {
    ...actual,
    readRuntimeConfig: () => mocks.runtimeConfig,
    captureRuntimeConfigAsyncReader: () => async () => mocks.runtimeConfig,
    getRuntimeConfigSourceSnapshot: () => mocks.runtimeSourceConfig,
    loadConfig: () => mocks.runtimeConfig,
  };
});

vi.mock("../browser/control-auth.js", () => ({
  ensureBrowserControlAuth: mocks.ensureBrowserControlAuth,
  resolveBrowserControlAuth: mocks.resolveBrowserControlAuth,
  shouldAutoGenerateBrowserAuth: mocks.shouldAutoGenerateBrowserAuth,
}));

// This suite tests shared state; server auth/bind suites cover real HTTP listeners.
vi.mock("../browser/http-listen.js", () => ({
  listenBrowserHttpServer: vi.fn(async () => createServer()),
}));

vi.mock("../browser/server-lifecycle.js", () => ({
  stopKnownBrowserProfiles: mocks.stopKnownBrowserProfiles,
}));

vi.mock("../browser/chrome.js", () => ({
  diagnoseChromeCdp: vi.fn(async () => ({ ok: false })),
  formatChromeCdpDiagnostic: vi.fn(() => "not reachable"),
  isChromeCdpReady: mocks.isChromeCdpReady,
  isChromeReachable: mocks.isChromeReachable,
  launchOpenClawChrome: vi.fn(async () => {
    throw new Error("launch should not be needed for status");
  }),
  resolveOpenClawUserDataDir: vi.fn(() => "/tmp/openclaw-browser"),
  stopOpenClawChrome: vi.fn(async () => {}),
}));

const { startBrowserControlServerFromConfig, stopBrowserControlServer } =
  await import("../server.js");
const { getBrowserControlState, startBrowserControlServiceFromConfig, stopBrowserControlService } =
  await import("../control-service.js");
const { runBrowserProxyCommand } = await import("../node-host/invoke-browser.js");
const { getBridgeAuthForPort } = await import("../browser/bridge-auth-registry.js");
const { browserHandlers } = await import("./browser-request.js");

const controlPort = 18_791;
const activePlugins = {
  allow: ["telegram", "browser"],
  entries: { browser: { enabled: true } },
};
const browserStatus = { enabled: true, profile: "openclaw" };
function browserConfig(browser: OpenClawConfig["browser"] = {}): OpenClawConfig {
  return {
    gateway: { port: controlPort - 2 },
    browser: {
      enabled: true,
      defaultProfile: "openclaw",
      profiles: { openclaw: { cdpPort: controlPort + 9 } },
      ...browser,
    },
  };
}

function setConfig(source: OpenClawConfig, runtime = source) {
  mocks.runtimeSourceConfig = source;
  mocks.runtimeConfig = runtime;
}

async function browserRequestStatus(): Promise<unknown> {
  const respond = vi.fn();
  await browserHandlers["browser.request"]({
    params: { method: "GET", path: "/", query: { profile: "openclaw" } },
    respond: respond as never,
    context: { nodeRegistry: { listConnected: () => [] } } as never,
    client: null,
    req: { type: "req", id: "req-1", method: "browser.request" },
    isWebchatConnect: () => false,
  });
  const [ok, result] = expectDefined(respond.mock.calls[0], "browser response");
  expect(ok).toBe(true);
  return result;
}

describe("browser.request local control state", () => {
  afterEach(async () => {
    await stopBrowserControlService();
    await stopBrowserControlServer();
    mocks.runtimeSourceConfig = null;
    vi.clearAllMocks();
  });

  it("uses the same resolved browser config as the HTTP control service", async () => {
    const source = {
      ...browserConfig({
        executablePath: "/usr/bin/google-chrome",
        headless: true,
        noSandbox: true,
      }),
      plugins: { allow: ["telegram"] },
    };
    const originalSource = structuredClone(source);
    setConfig(source, { ...source, plugins: activePlugins });
    const httpState = await startBrowserControlServerFromConfig();
    expect(httpState?.resolved).toMatchObject({
      executablePath: "/usr/bin/google-chrome",
      noSandbox: true,
    });

    // The runtime snapshot can lag behind source config after gateway startup;
    // browser.request must not fork a second stale control state from it.
    mocks.runtimeConfig = browserConfig({ headless: false, noSandbox: false });

    expect(await browserRequestStatus()).toMatchObject({
      executablePath: "/usr/bin/google-chrome",
      headless: true,
      noSandbox: true,
    });
    expect(source).toEqual(originalSource);
  });

  it("honors runtime plugin activation on a cold gateway request while retaining fresh browser options", async () => {
    const source = { ...browserConfig({ headless: true }), plugins: { allow: ["telegram"] } };
    const originalSource = structuredClone(source);
    setConfig(source, { ...browserConfig({ headless: false }), plugins: activePlugins });
    expect(await browserRequestStatus()).toMatchObject({ ...browserStatus, headless: true });
    expect(source).toEqual(originalSource);
  });

  it("retains effective plugin disablement at both cold entrypoints", async () => {
    const source = browserConfig();
    setConfig(source, { ...source, plugins: { allow: ["telegram"] } });
    expect(await startBrowserControlServiceFromConfig()).toBeNull();
    expect(await startBrowserControlServerFromConfig()).toBeNull();
    expect(mocks.ensureBrowserControlAuth).not.toHaveBeenCalled();
    expect(getBrowserControlState()).toBeNull();
  });

  it("retains a fresh browser disable even when the activated runtime options lag", async () => {
    const runtime = { ...browserConfig(), plugins: { ...activePlugins, allow: ["browser"] } };
    setConfig({ ...runtime, browser: { enabled: false } }, runtime);
    expect(await startBrowserControlServiceFromConfig()).toBeNull();
    expect(await startBrowserControlServerFromConfig()).toBeNull();
    expect(mocks.ensureBrowserControlAuth).not.toHaveBeenCalled();
  });

  it("retains port auth until a failed stop is retried successfully", async () => {
    setConfig(browserConfig());
    mocks.ensureBrowserControlAuth.mockResolvedValueOnce({ auth: { token: "test-token" } });
    const state = await startBrowserControlServerFromConfig();
    expect(state?.port).toBe(controlPort);
    expect(getBridgeAuthForPort(controlPort)).toEqual({ token: "test-token" });

    mocks.stopKnownBrowserProfiles.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(stopBrowserControlServer()).rejects.toThrow("cleanup failed");
    expect(getBridgeAuthForPort(controlPort)).toEqual({ token: "test-token" });

    await stopBrowserControlServer();
    expect(getBridgeAuthForPort(controlPort)).toBeUndefined();
  });

  it("clears auth when a stop queues behind cold startup", async () => {
    setConfig(browserConfig());
    const authStarted = createDeferred<void>();
    const authGate = createDeferred<void>();
    mocks.ensureBrowserControlAuth.mockImplementationOnce(async () => {
      authStarted.resolve();
      await authGate.promise;
      return { auth: { token: "test-token" } };
    });

    const starting = startBrowserControlServerFromConfig();
    await authStarted.promise;
    const stopping = stopBrowserControlServer();
    authGate.resolve();
    await expect(starting).resolves.toBeTruthy();
    await expect(stopping).resolves.toBeUndefined();
    expect(getBridgeAuthForPort(controlPort)).toBeUndefined();
  });

  it("restarts node proxy control after the shared service stops", async () => {
    const setEnabled = (enabled: boolean) => {
      setConfig(browserConfig({ enabled }));
    };
    const request = JSON.stringify({ method: "GET", path: "/", profile: "openclaw" });
    const proxy = () => runBrowserProxyCommand(request);
    const expectStatus = async () => {
      expect(JSON.parse(await proxy()).result).toMatchObject(browserStatus);
    };
    setEnabled(false);
    await expect(proxy()).rejects.toThrow("browser control disabled");
    setEnabled(true);
    await startBrowserControlServiceFromConfig();
    setEnabled(false);
    await expect(proxy()).rejects.toThrow("browser control disabled");

    setEnabled(true);
    await expectStatus();
    const previous = getBrowserControlState();
    expect(previous).not.toBeNull();
    setEnabled(false);
    await expectStatus();
    expect(getBrowserControlState()).toBe(previous);

    await stopBrowserControlService();
    expect(getBrowserControlState()).toBeNull();

    setEnabled(true);
    await expectStatus();
    expect(getBrowserControlState()).not.toBe(previous);
    expect(getBrowserControlState()).not.toBeNull();

    const stopStarted = createDeferred<void>();
    const stopGate = createDeferred<void>();
    mocks.stopKnownBrowserProfiles.mockImplementationOnce(async () => {
      stopStarted.resolve();
      await stopGate.promise;
    });
    const stopping = stopBrowserControlService();
    await stopStarted.promise;
    const duringStop = expect(proxy()).rejects.toThrow("stopping");
    stopGate.resolve();
    await stopping;
    await duringStop;
    expect(getBrowserControlState()).toBeNull();
    setEnabled(false);
    await expect(proxy()).rejects.toThrow("browser control disabled");
  });
});
