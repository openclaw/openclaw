import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBrowserBridgeServer, stopBrowserBridgeServer } from "./bridge-server.js";
import { resolveBrowserConfig } from "./config.js";

type Auth = { token?: string; password?: string };
const fixture = vi.hoisted(() => ({ configuredAuth: {} as Auth }));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>();
  return { ...actual, readRuntimeConfig: () => ({}) };
});
vi.mock("./control-auth.js", () => ({
  resolveBrowserControlAuth: () => fixture.configuredAuth,
}));
const { fetchBrowserJson } = await import("./client-fetch.js");

describe("fetchBrowserJson automatic auth over loopback HTTP", () => {
  beforeEach(() => {
    // Match existing real-HTTP browser fixtures; never route synthetic auth to a proxy.
    for (const key of ["ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY"]) {
      vi.stubEnv(key, "");
      vi.stubEnv(key.toLowerCase(), "");
    }
    fixture.configuredAuth = { token: "fixture-token" };
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { authToken: " \tfixture-private-bridge-token\n ", authPassword: undefined, reject: false },
    { authToken: undefined, authPassword: "fixture-password", reject: false },
    { authToken: "fixture-token", authPassword: undefined, reject: true },
  ])("uses bridge auth unless explicitly overridden (%j)", async ({ reject, ...auth }) => {
    const bridge = await startBrowserBridgeServer({
      resolved: resolveBrowserConfig({
        enabled: true,
        attachOnly: true,
        defaultProfile: "fixture",
        profiles: { fixture: { cdpPort: 1, color: "#123456" } },
      }),
      ...auth,
    });
    try {
      const request = fetchBrowserJson(`${bridge.baseUrl}/tabs?profile=fixture`, {
        headers: reject ? { Authorization: "" } : undefined,
      });
      if (reject) {
        await expect(request).rejects.toMatchObject({ name: "BrowserServiceError", status: 401 });
      } else {
        await expect(request).resolves.toEqual({ running: false, tabs: [] });
      }
    } finally {
      await stopBrowserBridgeServer(bridge.server);
    }
  });
});
