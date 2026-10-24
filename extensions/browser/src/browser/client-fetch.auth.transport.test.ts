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

const cases = [
  {
    name: "registered bridge password wins over Gateway auth",
    serverAuth: { password: "fixture-bridge-password" },
    configuredAuth: { token: "fixture-unrelated-gateway-token" },
    bridgeAuth: { password: "fixture-bridge-password" },
    status: 200,
  },
  {
    name: "empty explicit auth wins over registered and configured auth",
    serverAuth: { token: "fixture-token" },
    configuredAuth: { token: "fixture-token" },
    bridgeAuth: { token: "fixture-token" },
    headers: { Authorization: "" },
    status: 401,
  },
];

describe("fetchBrowserJson automatic auth over loopback HTTP", () => {
  beforeEach(() => {
    // Match existing real-HTTP browser fixtures; never route synthetic auth to a proxy.
    for (const key of ["ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY"]) {
      vi.stubEnv(key, "");
      vi.stubEnv(key.toLowerCase(), "");
    }
    fixture.configuredAuth = {};
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

  it.each(cases)("$name", async (testCase) => {
    const requests: number[] = [];
    await withServer(
      (req, res) => {
        const status = isAuthorizedBrowserRequest(req, testCase.serverAuth) ? 200 : 401;
        requests.push(status);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status === 200 ? { ok: true } : { error: "Unauthorized" }));
      },
      async (baseUrl) => {
        const port = Number(new URL(baseUrl).port);
        fixture.configuredAuth = testCase.configuredAuth;
        setBridgeAuthForPort(port, testCase.bridgeAuth);
        try {
          const request = fetchBrowserJson(`${baseUrl}/`, { headers: testCase.headers });
          if (testCase.status === 200) {
            await expect(request).resolves.toEqual({ ok: true });
          } else {
            await expect(request).rejects.toMatchObject({
              name: "BrowserServiceError",
              status: 401,
            });
          }
          expect(requests).toEqual([testCase.status]);
        } finally {
          deleteBridgeAuthForPort(port);
        }
      },
    );
  });
});
