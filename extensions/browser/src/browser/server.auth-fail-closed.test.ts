import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBrowserControlServerFromConfig, stopBrowserControlServer } from "../server.js";
import { getFreePort } from "./test-port.js";

const mocks = vi.hoisted(() => ({
  controlPort: 0,
  gatewayAuthMode: undefined as "password" | undefined,
  gatewayAuthToken: undefined as string | undefined,
  ensureBrowserControlAuth: vi.fn<() => Promise<{ auth: { token?: string; password?: string } }>>(
    async () => {
      throw new Error("read-only config");
    },
  ),
  resolveBrowserControlAuth: vi.fn(() => ({})),
  shouldAutoGenerateBrowserAuth: vi.fn(() => true),
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/runtime-config-snapshot")
  >("openclaw/plugin-sdk/runtime-config-snapshot");
  const loadConfig = () => ({
    browser: { enabled: true },
    gateway: { auth: { mode: mocks.gatewayAuthMode, token: mocks.gatewayAuthToken } },
  });
  return {
    ...actual,
    getRuntimeConfig: loadConfig,
    loadConfig,
  };
});

vi.mock("./config.js", async () => {
  const actual = await vi.importActual<typeof import("./config.js")>("./config.js");
  return {
    ...actual,
    resolveBrowserConfig: vi.fn(() => ({
      enabled: true,
      controlPort: mocks.controlPort,
    })),
  };
});

vi.mock("./control-auth.js", () => ({
  ensureBrowserControlAuth: mocks.ensureBrowserControlAuth,
  resolveBrowserControlAuth: mocks.resolveBrowserControlAuth,
  shouldAutoGenerateBrowserAuth: mocks.shouldAutoGenerateBrowserAuth,
}));

vi.mock("./routes/index.js", () => ({
  registerBrowserRoutes: vi.fn(() => {}),
}));

vi.mock("./server-context.js", () => ({
  createBrowserRouteContext: vi.fn(() => ({})),
}));

vi.mock("./server-lifecycle.js", () => ({
  stopKnownBrowserProfiles: vi.fn(async () => {}),
}));

describe("browser control auth bootstrap failures", () => {
  beforeEach(async () => {
    mocks.controlPort = await getFreePort();
    mocks.gatewayAuthMode = undefined;
    mocks.gatewayAuthToken = undefined;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await stopBrowserControlServer();
  });

  it("fails closed when auth bootstrap throws and no auth is configured", async () => {
    await expect(startBrowserControlServerFromConfig()).resolves.toBeNull();
    expect(mocks.ensureBrowserControlAuth).toHaveBeenCalledTimes(1);
    expect(mocks.resolveBrowserControlAuth).toHaveBeenCalledTimes(1);
  });

  it("fails closed when password mode drops an inactive token but has no password", async () => {
    mocks.gatewayAuthMode = "password";
    mocks.gatewayAuthToken = "inactive-token";
    mocks.ensureBrowserControlAuth.mockResolvedValueOnce({ auth: {} });

    await expect(startBrowserControlServerFromConfig()).resolves.toBeNull();
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
      await new Promise<void>((resolve) => {
        blocker.close(() => resolve());
      });
    }
  });
});
