import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBrowserControlServerFromConfig, stopBrowserControlServer } from "../server.js";
import { getFreePort } from "./test-port.js";

const mocks = vi.hoisted(() => ({
  controlPort: 0,
  gatewayAuthMode: undefined as "password" | undefined,
  gatewayAuthToken: undefined as string | undefined,
  ensureBrowserControlAuth: vi
    .fn<() => Promise<{ auth: { token?: string; password?: string } }>>()
    .mockRejectedValue(new Error("read-only config")),
  resolveBrowserControlAuth: vi.fn(() => ({})),
  shouldAutoGenerateBrowserAuth: vi.fn(() => true),
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => {
  const loadConfig = () => ({
    browser: { enabled: true },
    gateway: { auth: { mode: mocks.gatewayAuthMode, token: mocks.gatewayAuthToken } },
  });
  return {
    ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
    readRuntimeConfig: loadConfig,
    captureRuntimeConfigAsyncReader: () => async () => loadConfig(),
    loadConfig,
  };
});
vi.mock("./config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config.js")>()),
  resolveBrowserConfig: vi.fn(() => ({ enabled: true, controlPort: mocks.controlPort })),
}));
vi.mock("./control-auth.js", () => ({
  ensureBrowserControlAuth: mocks.ensureBrowserControlAuth,
  resolveBrowserControlAuth: mocks.resolveBrowserControlAuth,
  shouldAutoGenerateBrowserAuth: mocks.shouldAutoGenerateBrowserAuth,
}));
// mock-isolation: Auth bootstrap failures do not need real browser routes.
vi.mock("./routes/index.js", () => ({ registerBrowserRoutes: vi.fn(() => {}) }));
// mock-isolation: Keep auth bootstrap independent of browser profile state.
vi.mock("./server-context.js", () => ({ createBrowserRouteContext: vi.fn(() => ({})) }));
// mock-isolation: Server cleanup must not stop real browser profiles.
vi.mock("./server-lifecycle.js", () => ({ stopKnownBrowserProfiles: vi.fn(async () => {}) }));

describe("browser control auth bootstrap failures", () => {
  beforeEach(async () => {
    mocks.controlPort = await getFreePort();
    mocks.gatewayAuthMode = undefined;
    mocks.gatewayAuthToken = undefined;
    vi.clearAllMocks();
  });
  afterEach(stopBrowserControlServer);

  it.each([false, true])("fails closed (inactive password token=%s)", async (inactive) => {
    if (inactive) {
      mocks.gatewayAuthMode = "password";
      mocks.gatewayAuthToken = "inactive-token";
      mocks.ensureBrowserControlAuth.mockResolvedValueOnce({ auth: {} });
    }
    await expect(startBrowserControlServerFromConfig()).resolves.toBeNull();
    expect(mocks.ensureBrowserControlAuth).toHaveBeenCalledTimes(1);
    expect(mocks.resolveBrowserControlAuth).toHaveBeenCalledTimes(1);
  });

  it("returns null when the browser control port is already in use", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const address = blocker.address();
    if (!address || typeof address === "string") {
      throw new Error("expected blocker TCP address");
    }
    mocks.controlPort = address.port;
    mocks.ensureBrowserControlAuth.mockResolvedValueOnce({ auth: { token: "test-token" } });
    mocks.resolveBrowserControlAuth.mockReturnValueOnce({ token: "test-token" });
    mocks.shouldAutoGenerateBrowserAuth.mockReturnValueOnce(false);
    try {
      await expect(startBrowserControlServerFromConfig()).resolves.toBeNull();
    } finally {
      await blocker[Symbol.asyncDispose]();
    }
  });
});
