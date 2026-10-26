import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteBridgeAuthForPort, setBridgeAuthForPort } from "./bridge-auth-registry.js";
import { startBrowserBridgeServer, stopBrowserBridgeServer } from "./bridge-server.js";
import { resolveBrowserConfig } from "./config.js";
import { isAuthorizedBrowserRequest } from "./http-auth.js";

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

  it("reads the real bridge routes with its own auth when Gateway auth differs", async () => {
    fixture.configuredAuth = { token: "fixture-unrelated-gateway-token" };
    const bridge = await startBrowserBridgeServer({
      resolved: resolveBrowserConfig({
        enabled: true,
        attachOnly: true,
        defaultProfile: "fixture",
        profiles: { fixture: { cdpPort: 1, color: "#123456" } },
      }),
      authToken: " \tfixture-private-bridge-token\n ",
    });
    try {
      await expect(fetchBrowserJson(`${bridge.baseUrl}/tabs?profile=fixture`)).resolves.toEqual({
        running: false,
        tabs: [],
      });
    } finally {
      await stopBrowserBridgeServer(bridge.server);
    }
  });

  it.each([
    { auth: { password: "fixture-password" }, headers: undefined, status: 200 },
    { auth: { token: "fixture-token" }, headers: { Authorization: "" }, status: 401 },
  ])("respects bridge auth and explicit headers ($status)", async ({ auth, headers, status }) => {
    const requests: number[] = [];
    await withServer(
      (req, res) => {
        const responseStatus = isAuthorizedBrowserRequest(req, auth) ? 200 : 401;
        requests.push(responseStatus);
        res.writeHead(responseStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseStatus === 200 ? { ok: true } : { error: "Unauthorized" }));
      },
      async (baseUrl) => {
        const port = Number(new URL(baseUrl).port);
        setBridgeAuthForPort(port, auth);
        try {
          const request = fetchBrowserJson(`${baseUrl}/`, { headers });
          if (status === 200) {
            await expect(request).resolves.toEqual({ ok: true });
          } else {
            await expect(request).rejects.toMatchObject({
              name: "BrowserServiceError",
              status: 401,
            });
          }
          expect(requests).toEqual([status]);
        } finally {
          deleteBridgeAuthForPort(port);
        }
      },
    );
  });
});
