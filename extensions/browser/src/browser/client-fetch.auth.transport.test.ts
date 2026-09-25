import http from "node:http";
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
  return { ...actual, getRuntimeConfig: () => ({}) };
});
vi.mock("./control-auth.js", () => ({
  resolveBrowserControlAuth: () => fixture.configuredAuth,
}));
const { fetchBrowserJson } = await import("./client-fetch.js");

type AuthCase = {
  name: string;
  serverAuth: Auth;
  configuredAuth?: Auth;
  bridgeAuth?: Auth;
  headers?: Record<string, string>;
  status: 200 | 401;
};
const cases: AuthCase[] = [
  {
    name: "configured token crosses real HTTP",
    serverAuth: { token: "fixture-token" },
    configuredAuth: { token: "fixture-token" },
    status: 200,
  },
  {
    name: "registry password crosses real HTTP",
    serverAuth: { password: "fixture-password" },
    bridgeAuth: { password: "fixture-password" },
    status: 200,
  },
  ...[{ token: "fixture-bridge-token" }, { password: "fixture-bridge-password" }].map(
    (bridgeAuth): AuthCase => ({
      name: `registered bridge ${bridgeAuth.token ? "token" : "password"} wins over Gateway auth`,
      serverAuth: bridgeAuth,
      configuredAuth: { token: "fixture-unrelated-gateway-token" },
      bridgeAuth,
      status: 200,
    }),
  ),
  {
    name: "explicit auth still wins over registered bridge auth",
    serverAuth: { token: "fixture-token" },
    configuredAuth: { token: "fixture-unrelated-gateway-token" },
    bridgeAuth: { token: "fixture-token" },
    headers: { Authorization: "Bearer fixture-wrong-token" },
    status: 401,
  },
  {
    name: "missing auth receives real 401",
    serverAuth: { token: "fixture-token" },
    status: 401,
  },
  {
    name: "wrong explicit auth is not replaced by configured auth",
    serverAuth: { token: "fixture-token" },
    configuredAuth: { token: "fixture-token" },
    headers: { Authorization: "Bearer fixture-wrong-token" },
    status: 401,
  },
  {
    name: "empty explicit auth is not replaced by configured auth",
    serverAuth: { token: "fixture-token" },
    configuredAuth: { token: "fixture-token" },
    headers: { Authorization: "" },
    status: 401,
  },
];

describe("fetchBrowserJson automatic auth over loopback HTTP", () => {
  let server: http.Server | undefined;
  let port: number | undefined;
  let serverAuth: Auth;
  let requests: number[];

  beforeEach(async () => {
    // Match existing real-HTTP browser fixtures; never route synthetic auth to a proxy.
    for (const key of [
      "ALL_PROXY",
      "all_proxy",
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
    ]) {
      vi.stubEnv(key, "");
    }
    fixture.configuredAuth = {};
    serverAuth = {};
    requests = [];
    port = undefined;
    const listener = http.createServer((req, res) => {
      const status = isAuthorizedBrowserRequest(req, serverAuth) ? 200 : 401;
      requests.push(status);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status === 200 ? { ok: true } : { error: "Unauthorized" }));
    });
    server = listener;
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => {
        listener.off("error", reject);
        resolve();
      });
    });
    const address = listener.address();
    if (!address || typeof address === "string") {
      throw new Error("expected owned loopback listener");
    }
    port = address.port;
  });

  afterEach(async () => {
    try {
      if (port !== undefined) {
        deleteBridgeAuthForPort(port);
      }
      port = undefined;
      const listener = server;
      server = undefined;
      if (!listener) {
        return;
      }
      if (!listener.listening) {
        listener.closeAllConnections();
        return;
      }
      const closed = new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      });
      listener.closeAllConnections();
      await closed;
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads the real bridge routes with its own auth when Gateway auth differs", async () => {
    fixture.configuredAuth = { token: "fixture-unrelated-gateway-token" };
    const bridge = await startBrowserBridgeServer({
      resolved: resolveBrowserConfig({
        enabled: true,
        attachOnly: true,
        defaultProfile: "fixture",
        profiles: { fixture: { cdpPort: 1, color: "#123456" } },
      }),
      authToken: "fixture-private-bridge-token",
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
    serverAuth = testCase.serverAuth;
    fixture.configuredAuth = testCase.configuredAuth ?? {};
    const listenerPort = port;
    if (listenerPort === undefined) {
      throw new Error("expected owned listener port");
    }
    if (testCase.bridgeAuth) {
      setBridgeAuthForPort(listenerPort, testCase.bridgeAuth);
    }
    const request = fetchBrowserJson(`http://127.0.0.1:${listenerPort}/`, {
      headers: testCase.headers,
    });
    if (testCase.status === 200) {
      await expect(request).resolves.toEqual({ ok: true });
    } else {
      await expect(request).rejects.toMatchObject({ name: "BrowserServiceError", status: 401 });
    }
    expect(requests).toEqual([testCase.status]);
  });
});
