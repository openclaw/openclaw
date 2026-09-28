import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolvePluginRoutePathContext } from "openclaw/plugin-sdk/gateway-config-runtime";
import { acquireTestPortBlock } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getMSTeamsIngressMockState } from "./monitor-ingress-mock.test-support.js";
import {
  createConfig,
  createRuntime,
  createStores,
  updateMSTeamsConfig,
} from "./monitor-lifecycle.test-helpers.js";
import {
  routeState,
  loadMSTeamsSdkWithAuth,
  resetMSTeamsMonitorMocks,
} from "./monitor-lifecycle.test-support.js";
import { monitorMSTeamsProvider } from "./monitor.js";

let gateway: Server;
let claim: Awaited<ReturnType<typeof acquireTestPortBlock>>;

async function resolveStartedServer(): Promise<Server> {
  await routeState.ready.promise;
  return gateway;
}

function resolveServerUrl(server: Server, path: string): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP server address");
  }
  return `http://127.0.0.1:${address.port}${path}`;
}

describe("Microsoft Teams Gateway webhook lifecycle", () => {
  beforeAll(async () => {
    claim = await acquireTestPortBlock({ offsets: [0] });
    gateway = createServer((req, res) => {
      const { canonicalPath } = resolvePluginRoutePathContext(
        new URL(req.url ?? "/", "http://localhost").pathname,
      );
      const route = routeState.routes.find(
        (entry) => resolvePluginRoutePathContext(entry.path ?? "/").canonicalPath === canonicalPath,
      );
      if (!route) {
        res.writeHead(404).end();
        return;
      }
      routeState.responseWork = Promise.resolve(route.handler(req, res));
    });
    gateway.listen(claim.port, "127.0.0.1");
    await once(gateway, "listening");
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      gateway.close((error) => (error ? reject(error) : resolve()));
    });
    await claim.release();
  });
  afterEach(resetMSTeamsMonitorMocks);

  it.each([
    [undefined, { port: 3978 }],
    [
      { port: 44978, host: "127.0.0.1" },
      { port: 44978, host: "127.0.0.1" },
    ],
    [false, undefined],
  ] as const)(
    "registers the effective compatibility listener for %s",
    async (setting, endpoint) => {
      const cfg = createConfig();
      updateMSTeamsConfig(cfg, { legacyWebhook: setting });
      const abort = new AbortController();
      const task = monitorMSTeamsProvider({
        cfg,
        runtime: createRuntime(),
        abortSignal: abort.signal,
        ...createStores(),
      });
      await routeState.ready.promise;
      expect(routeState.routes[0]?.legacyListener).toEqual(
        endpoint && {
          ...endpoint,
          timeouts: { headers: 15000, request: 30000, socket: 30000 },
        },
      );
      abort.abort();
      await task;
      expect(routeState.unregister).toHaveBeenCalledOnce();
    },
  );

  it.each(["/api/:tenant/messages", "/api{/messages}", "/healthz"])(
    "fails visibly when %s cannot serve Gateway-only callbacks",
    async (path) => {
      const cfg = createConfig();
      updateMSTeamsConfig(cfg, { webhook: { path } });
      await expect(
        monitorMSTeamsProvider({ cfg, runtime: createRuntime(), ...createStores() }),
      ).rejects.toThrow("Set channels.msteams.webhook.path to /api/messages");
      expect(routeState.routes).toEqual([]);
    },
  );

  it("stops ingress when Gateway route registration fails", async () => {
    routeState.fail = true;
    await expect(
      monitorMSTeamsProvider({
        cfg: createConfig(),
        runtime: createRuntime(),
        ...createStores(),
      }),
    ).rejects.toThrow("route conflict");
    expect(getMSTeamsIngressMockState().instances[0]?.stop).toHaveBeenCalledOnce();
  });

  it("rejects requests without Bearer token before SDK route", async () => {
    const abort = new AbortController();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    const server = await resolveStartedServer();
    const unauthorized = await fetch(resolveServerUrl(server, "/api/messages"), {
      method: "POST",
    });
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({ error: "Unauthorized" });

    const authorized = await fetch(resolveServerUrl(server, "/api/messages"), {
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
    });
    expect(authorized.status).toBe(200);

    abort.abort();
    await task;
  });

  it("keeps oversized webhook parse failures JSON-shaped", async () => {
    const abort = new AbortController();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    const server = await resolveStartedServer();
    const response = await fetch(resolveServerUrl(server, "/api/messages"), {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ payload: "x".repeat(1024 * 1024) }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Payload too large" });

    abort.abort();
    await task;
  });

  it.each([
    ["gzip", gzipSync],
    ["deflate", deflateSync],
    ["br", brotliCompressSync],
  ] as const)("retains %s decoding and the decoded body limit", async (encoding, compress) => {
    const abort = new AbortController();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      ...createStores(),
    });
    try {
      const server = await resolveStartedServer();
      for (const [payload, status] of [
        ["ok", 200],
        ["x".repeat(1024 * 1024), 413],
      ] as const) {
        const response = await fetch(resolveServerUrl(server, "/api/messages"), {
          method: "POST",
          headers: {
            authorization: "Bearer valid-token",
            "content-type": "application/json",
            "content-encoding": encoding,
          },
          body: compress(JSON.stringify({ payload })),
        });
        expect(response.status).toBe(status);
        if (status === 413) {
          await expect(response.json()).resolves.toEqual({ error: "Payload too large" });
        } else {
          await response.text();
        }
      }
    } finally {
      abort.abort();
      await task;
    }
  });

  it("keeps bearer-gated Express OPTIONS and method responses", async () => {
    const abort = new AbortController();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      ...createStores(),
    });
    try {
      const server = await resolveStartedServer();
      for (const path of ["/api/messages", "/API/MESSAGES/", "/api/messages?tenant=one"]) {
        const unauthenticated = await fetch(resolveServerUrl(server, path), { method: "OPTIONS" });
        expect(unauthenticated.status).toBe(401);
        await expect(unauthenticated.json()).resolves.toEqual({ error: "Unauthorized" });
        const response = await fetch(resolveServerUrl(server, path), {
          method: "OPTIONS",
          headers: { authorization: "Bearer valid-token" },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("allow")).toBe("POST");
        expect(response.headers.get("x-powered-by")).toBe("Express");
        expect(response.headers.get("content-length")).toBe("4");
        await expect(response.text()).resolves.toBe("POST");
      }
      const response = await fetch(resolveServerUrl(server, "/api/messages"), {
        headers: { authorization: "Bearer valid-token" },
      });
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("text/html");
      await expect(response.text()).resolves.toContain("Cannot GET /api/messages");
    } finally {
      abort.abort();
      await task;
    }
  });

  it("drains active responses before releasing the route and rejects new work during stop", async () => {
    const gate = createDeferred<void>();
    routeState.responseGate = gate.promise;
    routeState.unregister.mockImplementation(() => gateway.closeAllConnections());
    const abort = new AbortController();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      ...createStores(),
    });
    try {
      const server = await resolveStartedServer();
      const response = fetch(resolveServerUrl(server, "/api/messages"), {
        method: "POST",
        headers: { authorization: "Bearer valid-token" },
      });
      await routeState.requestStarted.promise;
      let settled = false;
      const activeResponseWork = routeState.responseWork;
      void activeResponseWork?.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      abort.abort();
      const lateResponse = await fetch(resolveServerUrl(server, "/api/messages"), {
        method: "POST",
        headers: { authorization: "Bearer valid-token" },
      });
      expect(lateResponse.status).toBe(503);
      expect(lateResponse.headers.get("retry-after")).toBe("1");
      await lateResponse.text();
      expect(routeState.unregister).not.toHaveBeenCalled();
      expect(getMSTeamsIngressMockState().instances[0]?.stop).not.toHaveBeenCalled();
      gate.resolve();
      const completedResponse = await response;
      expect(completedResponse.status).toBe(200);
      await completedResponse.text();
      await activeResponseWork;
      expect(settled).toBe(true);
      await task;
      expect(routeState.unregister).toHaveBeenCalledOnce();
      expect(getMSTeamsIngressMockState().instances[0]?.stop).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      abort.abort();
      await task;
    }
  });

  it("bounds response drain to the shipped 30-second window", async () => {
    const gate = createDeferred<void>();
    routeState.responseGate = gate.promise;
    const abort = new AbortController();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      ...createStores(),
    });
    try {
      const server = await resolveStartedServer();
      const response = fetch(resolveServerUrl(server, "/api/messages"), {
        method: "POST",
        headers: { authorization: "Bearer valid-token" },
      }).then(
        () => "responded",
        () => "closed",
      );
      await routeState.requestStarted.promise;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      abort.abort();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(routeState.unregister).not.toHaveBeenCalled();
      expect(getMSTeamsIngressMockState().instances[0]?.stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await task;
      expect(routeState.unregister).toHaveBeenCalledOnce();
      await expect(response).resolves.toBe("closed");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      gate.resolve();
      vi.useRealTimers();
      abort.abort();
      await task;
    }
  });

  it("requires the per-run QA token before parsing even when SDK auth is disabled", async () => {
    vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1");
    vi.stubGlobal(Symbol.for("openclaw.msteams.privateQaRuntime"), {
      connectorUrl: "http://127.0.0.1:43123/",
      nonce: "synthetic-nonce",
      botToken: "synthetic-run-token",
    });
    const abort = new AbortController();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      ...createStores(),
    });
    try {
      const server = await resolveStartedServer();
      for (const token of ["private-qa", "synthetic-run-token"]) {
        const response = await fetch(resolveServerUrl(server, "/api/messages"), {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: "{",
        });
        expect(response.status).toBe(token === "private-qa" ? 401 : 400);
        await response.text();
      }
    } finally {
      abort.abort();
      await task;
    }
  });

  it.each([
    { path: undefined, endpoint: "/api/messages" },
    { path: "", endpoint: "/api/messages" },
    { path: "/teams/events", endpoint: "/teams/events" },
  ])("routes /api/messages with configured path $path", async ({ path, endpoint }) => {
    const abort = new AbortController();
    const cfg = createConfig();
    updateMSTeamsConfig(cfg, { webhook: { path } });
    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      ...createStores(),
    });
    try {
      const server = await resolveStartedServer();
      expect(routeState.routes[0]?.path).toBe(endpoint);
      expect(loadMSTeamsSdkWithAuth.mock.calls[0]?.[1]).toMatchObject({
        messagingEndpoint: endpoint,
      });
      const response = await fetch(resolveServerUrl(server, "/api/messages"), {
        method: "POST",
        headers: { authorization: "Bearer valid" },
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ url: endpoint });
      if (endpoint !== "/api/messages") {
        routeState.routes = routeState.routes.filter((route) => route.path !== "/api/messages");
        const unregistered = await fetch(resolveServerUrl(server, "/api/messages"), {
          method: "POST",
          headers: { authorization: "Bearer valid" },
        });
        expect(unregistered.status).toBe(404);
        await unregistered.text();
      }
    } finally {
      abort.abort();
      await task;
    }
  });
});
