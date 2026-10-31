import { createServer } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, expect, it, vi } from "vitest";
import { makeRequest, deferredOperation } from "./browser-request.test-support.js";

const mocks = vi.hoisted(() => ({
  runtimeConfig: {} as OpenClawConfig,
  runtimeSourceConfig: null as OpenClawConfig | null,
  ensureBrowserControlAuth: vi.fn(async () => ({ auth: {} })),
  stopKnownBrowserProfiles: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: () => mocks.runtimeConfig,
  captureRuntimeConfigAsyncReader: () => async () => mocks.runtimeConfig,
  getRuntimeConfigSourceSnapshot: () => mocks.runtimeSourceConfig,
  loadConfig: () => mocks.runtimeConfig,
}));

// mock-isolation: Auth generation and persistence are outside this shared-control lifecycle fixture.
vi.mock("../browser/control-auth.js", () => ({
  ensureBrowserControlAuth: mocks.ensureBrowserControlAuth,
  resolveBrowserControlAuth: vi.fn(() => ({})),
  shouldAutoGenerateBrowserAuth: vi.fn(() => false),
}));

// This suite tests shared state; server auth/bind suites cover real HTTP listeners.
vi.mock("../browser/http-listen.js", () => ({
  listenBrowserHttpServer: vi.fn(async () => createServer()),
}));

vi.mock("../browser/server-lifecycle.js", () => ({
  stopKnownBrowserProfiles: mocks.stopKnownBrowserProfiles,
}));

// mock-isolation: Shared-control lifecycle tests must not discover or launch a real browser.
vi.mock("../browser/chrome.js", () => ({
  diagnoseChromeCdp: vi.fn(async () => ({ ok: false })),
  formatChromeCdpDiagnostic: vi.fn(() => "not reachable"),
  isChromeCdpReady: vi.fn(async () => false),
  isChromeReachable: vi.fn(async () => false),
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
const { getBridgeAuthForPort } = await import("../browser/bridge-auth-registry.js");
const { browserHandlers } = await import("./browser-request.js");

const controlPort = 18_791;
const activePlugins = { allow: ["telegram", "browser"], entries: { browser: { enabled: true } } };
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
  await browserHandlers["browser.request"](
    makeRequest({ method: "GET", path: "/", query: { profile: "openclaw" } }, { respond }),
  );
  const [ok, result] = expectDefined(respond.mock.calls[0], "browser response");
  expect(ok).toBe(true);
  return result;
}

afterEach(async () => {
  await stopBrowserControlService();
  await stopBrowserControlServer();
  mocks.runtimeSourceConfig = null;
  vi.clearAllMocks();
});

it.each([false, true])(
  "uses fresh browser options with runtime activation (HTTP started=%s)",
  async (started) => {
    const options = { executablePath: "/usr/bin/google-chrome", headless: true, noSandbox: true };
    const source = { ...browserConfig(options), plugins: { allow: ["telegram"] } };
    const originalSource = structuredClone(source);
    setConfig(source, { ...browserConfig({ headless: false }), plugins: activePlugins });
    if (started) {
      expect((await startBrowserControlServerFromConfig())?.resolved).toMatchObject(options);
    }
    mocks.runtimeConfig = browserConfig({ enabled: !started, headless: false, noSandbox: false });
    if (!started) {
      mocks.runtimeConfig.plugins = activePlugins;
    }
    expect(await browserRequestStatus()).toMatchObject({ ...browserStatus, ...options });
    expect(source).toEqual(originalSource);
  },
);

it.each(["plugin", "browser"])("retains %s disablement at both cold entrypoints", async (kind) => {
  const runtime = { ...browserConfig(), plugins: { ...activePlugins, allow: ["browser"] } };
  const source = kind === "plugin" ? browserConfig() : { ...runtime, browser: { enabled: false } };
  setConfig(source, kind === "plugin" ? { ...source, plugins: { allow: ["telegram"] } } : runtime);
  expect(await startBrowserControlServiceFromConfig()).toBeNull();
  expect(await startBrowserControlServerFromConfig()).toBeNull();
  expect(mocks.ensureBrowserControlAuth).not.toHaveBeenCalled();
  expect(getBrowserControlState()).toBeNull();
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
  const auth = deferredOperation<{ auth: { token: string } }>();
  mocks.ensureBrowserControlAuth.mockImplementationOnce(auth.run);

  const starting = startBrowserControlServerFromConfig();
  await auth.entered;
  const stopping = stopBrowserControlServer();
  auth.resolve({ auth: { token: "test-token" } });
  await expect(starting).resolves.toBeTruthy();
  await expect(stopping).resolves.toBeUndefined();
  expect(getBridgeAuthForPort(controlPort)).toBeUndefined();
});
