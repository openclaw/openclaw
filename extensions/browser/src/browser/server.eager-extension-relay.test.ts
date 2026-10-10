import { createServer } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBrowserControlServerFromConfig, stopBrowserControlServer } from "../server.js";

const EAGER_BROWSER_CONTROL_SERVER_ENV = "OPENCLAW_EAGER_BROWSER_CONTROL_SERVER";

const mocks = vi.hoisted(() => ({
  runtimeConfig: {} as OpenClawConfig,
  listenBrowserHttpServer: vi.fn(async () => createServer()),
  startConfiguredExtensionRelays: vi.fn(async () => undefined),
  ensureBrowserControlAuth: vi.fn(async () => ({ auth: { token: "test-token" } })),
  resolveBrowserControlAuth: vi.fn(() => ({ token: "test-token" })),
  shouldAutoGenerateBrowserAuth: vi.fn(() => false),
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>();
  return {
    ...actual,
    getRuntimeConfig: () => mocks.runtimeConfig,
    getRuntimeConfigSourceSnapshot: () => mocks.runtimeConfig,
    loadConfig: () => mocks.runtimeConfig,
  };
});

vi.mock("./http-listen.js", () => ({
  listenBrowserHttpServer: mocks.listenBrowserHttpServer,
}));

vi.mock("./server-lifecycle.js", () => ({
  stopKnownBrowserProfiles: vi.fn(async () => {}),
}));

vi.mock("./control-auth.js", () => ({
  ensureBrowserControlAuth: mocks.ensureBrowserControlAuth,
  resolveBrowserControlAuth: mocks.resolveBrowserControlAuth,
  shouldAutoGenerateBrowserAuth: mocks.shouldAutoGenerateBrowserAuth,
}));

vi.mock("./extension-relay.runtime.js", () => ({
  getExtensionRelayModule: async () => ({
    startConfiguredExtensionRelays: mocks.startConfiguredExtensionRelays,
  }),
  getGatewayExtensionRelayModule: {
    peek: async () => undefined,
  },
}));

function browserConfig(browser: OpenClawConfig["browser"] = {}): OpenClawConfig {
  return {
    gateway: { port: 18789 },
    plugins: { allow: ["browser"], entries: { browser: { enabled: true } } },
    browser: {
      enabled: true,
      ...browser,
    },
  };
}

describe("eager browser control server extension relays", () => {
  beforeEach(() => {
    mocks.runtimeConfig = browserConfig({
      profiles: { chrome: { driver: "extension", cdpPort: 18799 } },
    });
    mocks.listenBrowserHttpServer.mockReset().mockImplementation(async () => createServer());
    mocks.startConfiguredExtensionRelays.mockReset().mockResolvedValue(undefined);
    mocks.ensureBrowserControlAuth.mockReset().mockResolvedValue({
      auth: { token: "test-token" },
    });
    mocks.resolveBrowserControlAuth.mockReset().mockReturnValue({ token: "test-token" });
    mocks.shouldAutoGenerateBrowserAuth.mockReset().mockReturnValue(false);
  });

  afterEach(async () => {
    try {
      await stopBrowserControlServer();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("starts the configured extension relay when eager browser control startup runs", async () => {
    vi.stubEnv(EAGER_BROWSER_CONTROL_SERVER_ENV, "1");

    const state = await startBrowserControlServerFromConfig();

    expect(state?.port).toBe(18791);
    expect(mocks.listenBrowserHttpServer).toHaveBeenCalledWith(
      expect.anything(),
      18791,
      "127.0.0.1",
    );
    expect(mocks.startConfiguredExtensionRelays).toHaveBeenCalledOnce();
    const [relayState, resolveProfileByName, onWarn] =
      mocks.startConfiguredExtensionRelays.mock.calls[0] ?? [];
    expect(relayState).toBe(state);
    expect(resolveProfileByName?.("chrome")).toMatchObject({
      driver: "extension",
      cdpPort: 18799,
      cdpHost: "127.0.0.1",
    });
    expect(resolveProfileByName?.("openclaw")?.driver).not.toBe("extension");
    expect(onWarn).toEqual(expect.any(Function));
    expect(mocks.ensureBrowserControlAuth).toHaveBeenCalledOnce();
  });

  it("does not start extension relays when eager startup is off", async () => {
    vi.stubEnv(EAGER_BROWSER_CONTROL_SERVER_ENV, "0");

    await startBrowserControlServerFromConfig();

    expect(mocks.listenBrowserHttpServer).toHaveBeenCalledOnce();
    expect(mocks.startConfiguredExtensionRelays).not.toHaveBeenCalled();
  });

  it("does not start extension relays when the eager flag is unset", async () => {
    vi.stubEnv(EAGER_BROWSER_CONTROL_SERVER_ENV, "");

    await startBrowserControlServerFromConfig();

    expect(mocks.startConfiguredExtensionRelays).not.toHaveBeenCalled();
  });

  it("does not bind a relay for managed profiles when eager startup is on", async () => {
    vi.stubEnv(EAGER_BROWSER_CONTROL_SERVER_ENV, "1");
    mocks.runtimeConfig = browserConfig({
      profiles: {
        chrome: { driver: "existing-session", attachOnly: true },
      },
    });

    await startBrowserControlServerFromConfig();

    expect(mocks.listenBrowserHttpServer).toHaveBeenCalledOnce();
    expect(mocks.startConfiguredExtensionRelays).not.toHaveBeenCalled();
  });

  it("does not start relays when eager startup is on but the control server cannot bind", async () => {
    vi.stubEnv(EAGER_BROWSER_CONTROL_SERVER_ENV, "1");
    mocks.listenBrowserHttpServer.mockResolvedValueOnce(null as never);

    await expect(startBrowserControlServerFromConfig()).resolves.toBeNull();
    expect(mocks.startConfiguredExtensionRelays).not.toHaveBeenCalled();
  });

  it("starts the default chrome extension relay when eager startup is on", async () => {
    vi.stubEnv(EAGER_BROWSER_CONTROL_SERVER_ENV, "1");
    mocks.runtimeConfig = browserConfig();

    await startBrowserControlServerFromConfig();

    expect(mocks.startConfiguredExtensionRelays).toHaveBeenCalledOnce();
    const [, resolveProfileByName] = mocks.startConfiguredExtensionRelays.mock.calls[0] ?? [];
    expect(resolveProfileByName?.("chrome")).toMatchObject({
      driver: "extension",
      cdpHost: "127.0.0.1",
    });
  });

  it("keeps the loopback control server up when eager relay startup fails", async () => {
    vi.stubEnv(EAGER_BROWSER_CONTROL_SERVER_ENV, "1");
    mocks.startConfiguredExtensionRelays.mockRejectedValueOnce(new Error("relay down"));

    await expect(startBrowserControlServerFromConfig()).resolves.toMatchObject({ port: 18791 });
    expect(mocks.listenBrowserHttpServer).toHaveBeenCalledWith(
      expect.anything(),
      18791,
      "127.0.0.1",
    );
  });

  it("does not start relays when browser control is disabled", async () => {
    vi.stubEnv(EAGER_BROWSER_CONTROL_SERVER_ENV, "1");
    mocks.runtimeConfig = browserConfig({ enabled: false });

    await expect(startBrowserControlServerFromConfig()).resolves.toBeNull();
    expect(mocks.listenBrowserHttpServer).not.toHaveBeenCalled();
    expect(mocks.startConfiguredExtensionRelays).not.toHaveBeenCalled();
    expect(mocks.ensureBrowserControlAuth).not.toHaveBeenCalled();
  });
});
