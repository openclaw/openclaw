import { once } from "node:events";
import { Agent, createServer, request, type IncomingHttpHeaders } from "node:http";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import { createCodexInferenceProxy, type CodexInferenceProxy } from "./inference-proxy.js";

const transport = vi.hoisted(() => {
  const wsAgents: unknown[] = [];
  return {
    fetch: vi.fn(),
    proxyAgent: vi.fn(),
    resolve: vi.fn(),
    upstream: "",
    dials: [] as string[],
    wsAgents,
  };
});
vi.mock("openclaw/plugin-sdk/fetch-runtime", () => ({
  createNodeProxyAgent: transport.proxyAgent,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    fetchWithSsrFGuard: transport.fetch,
    isBlockedHostnameOrIp: actual.isBlockedHostnameOrIp,
    resolvePinnedHostnameWithPolicy: transport.resolve,
  };
});
vi.mock("ws", async (original) => {
  const actual = await original<typeof import("ws")>();
  return {
    ...actual,
    default: class extends actual.default {
      constructor(url: string | URL, options?: import("ws").ClientOptions) {
        const value = String(url);
        if (value.startsWith("wss:")) {
          transport.dials.push(value);
          transport.wsAgents.push(options?.agent);
          super(transport.upstream, options);
        } else {
          super(url, options);
        }
      }
    },
  };
});
const proxies: CodexInferenceProxy[] = [];
beforeEach(() => {
  transport.fetch.mockReset();
  transport.proxyAgent.mockReset();
  transport.resolve.mockReset().mockResolvedValue({
    hostname: "api.openai.com",
    addresses: ["127.0.0.1"],
    lookup: undefined,
  });
  transport.wsAgents.length = 0;
  transport.dials = [];
});
afterEach(() => {
  for (const proxy of proxies.splice(0)) {
    proxy.close();
  }
});

async function post(
  url: string,
  options: { method: string; body: string | Buffer; headers?: Record<string, string> },
) {
  if (new URL(url).hostname !== "127.0.0.1") {
    throw new Error("fixture requires its own loopback server");
  }
  return await new Promise<{ status: number | undefined; text: () => Promise<string> }>(
    (resolve, reject) => {
      const req = request(
        url,
        { method: options.method, headers: options.headers, agent: false },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.once("error", reject);
          res.once("end", () =>
            resolve({ status: res.statusCode, text: async () => Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.once("error", reject);
      req.end(options.body);
    },
  );
}

async function fixture(withInstructions = true) {
  const proxy = await createCodexInferenceProxy({
    upstream: new URL("https://api.openai.com/v1"),
    assertCurrent: () => {},
  });
  proxies.push(proxy);
  const controller = new AbortController();
  const registration = proxy.context.register({
    threadId: "root",
    text: "synthetic persona",
    signal: controller.signal,
    assertCurrent: () => {},
  });
  const body = {
    ...(withInstructions ? { instructions: "native base" } : {}),
    input: [{ role: "developer", content: "catalog" }],
    client_metadata: {
      thread_id: "root",
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: "root",
        request_kind: "turn",
        [CODEX_INFERENCE_GENERATION_KEY]: registration.generation,
      }),
    },
  };
  return { proxy, controller, registration, body };
}

describe("private inference HTTP relay", () => {
  it.each([
    { zstd: false, withInstructions: true },
    { zstd: true, withInstructions: true },
    { zstd: false, withInstructions: false },
    { zstd: true, withInstructions: false },
  ])(
    "preserves auth and native input (zstd=$zstd, top-level instructions=$withInstructions)",
    async ({ zstd, withInstructions }) => {
      const { proxy, body } = await fixture(withInstructions);
      let forwarded: unknown;
      transport.fetch.mockImplementation(async (args) => {
        args.beforeRequest();
        const bytes = zstd ? zstdDecompressSync(args.init.body) : args.init.body;
        forwarded = JSON.parse(bytes.toString());
        expect(args.url).toBe("https://api.openai.com/v1/responses");
        expect(args.init.headers.authorization).toBe("Bearer synthetic-native-auth");
        expect(args.capture).toBe(false);
        expect(args.mode).toBe("trusted_env_proxy");
        expect(args.maxRedirects).toBe(0);
        return {
          response: new Response("data: synthetic\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
          release: async () => {},
        };
      });
      const bytes = Buffer.from(JSON.stringify(body));
      const response = await post(proxy.baseUrl + "/responses", {
        method: "POST",
        body: zstd ? zstdCompressSync(bytes) : bytes,
        headers: {
          authorization: "Bearer synthetic-native-auth",
          ...(zstd ? { "content-encoding": "zstd" } : {}),
        },
      });
      expect(transport.fetch).toHaveBeenCalledTimes(1);
      await transport.fetch.mock.results[0]?.value;
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("data: synthetic\n\n");
      expect(forwarded).toEqual({
        ...body,
        instructions: withInstructions ? "native base\n\nsynthetic persona" : "synthetic persona",
      });
    },
  );

  it("rejects missing private route authority and stale admitted generation without an upstream call", async () => {
    const { proxy, registration, body } = await fixture();
    const unknownRoute = new URL(proxy.baseUrl).origin + "/responses";
    const response = await post(unknownRoute, { method: "POST", body: JSON.stringify(body) });
    expect(response.status).toBe(502);
    registration.release();
    const stale = await post(proxy.baseUrl + "/responses", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(stale.status).toBe(502);
    expect(await stale.text()).not.toContain("synthetic persona");
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it("revalidates admission after asynchronous transport preparation", async () => {
    const { proxy, controller, body } = await fixture();
    let writes = 0;
    transport.fetch.mockImplementation(async (args) => {
      controller.abort();
      args.beforeRequest();
      writes++;
      throw new Error("must not reach the upstream");
    });
    const response = await post(proxy.baseUrl + "/responses", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(502);
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(writes).toBe(0);
  });

  it("passes native unauthorized responses through for native auth recovery", async () => {
    const { proxy, body } = await fixture();
    transport.fetch.mockResolvedValue({
      response: new Response("native unauthorized", { status: 401 }),
      release: async () => {},
    });
    const response = await post(proxy.baseUrl + "/responses", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("native unauthorized");
  });
});

describe("private inference WebSocket relay", () => {
  it.each(["unavailable", "private"] as const)(
    "rejects %s destination DNS on a direct WebSocket route",
    async (resolution) => {
      if (resolution === "unavailable") {
        transport.resolve.mockRejectedValue(new Error("synthetic DNS failure"));
      } else {
        const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
          "openclaw/plugin-sdk/ssrf-runtime",
        );
        transport.resolve.mockImplementation(
          (hostname: string, options: { signal?: AbortSignal }) =>
            actual.resolvePinnedHostnameWithPolicy(hostname, {
              ...options,
              lookupFn: async () => [{ address: "127.0.0.1", family: 4 }],
            }),
        );
      }
      const { proxy } = await fixture();
      const socket = new WebSocket(proxy.baseUrl.replace("http:", "ws:") + "/responses");
      try {
        await once(socket, "error");
        expect(transport.resolve).toHaveBeenCalledOnce();
        expect(transport.proxyAgent).toHaveBeenCalledOnce();
        expect(transport.dials).toEqual([]);
      } finally {
        socket.terminate();
      }
    },
  );

  it.each(["https://127.0.0.1/v1", "https://service.internal/v1"])(
    "rejects blocked hostname %s before proxy or DNS work",
    async (upstream) => {
      const agent = new Agent();
      transport.proxyAgent.mockReturnValue(agent);
      const proxy = await createCodexInferenceProxy({
        upstream: new URL(upstream),
        assertCurrent: () => {},
      });
      proxies.push(proxy);
      const socket = new WebSocket(proxy.baseUrl.replace("http:", "ws:") + "/responses");
      try {
        await once(socket, "error");
        expect(transport.proxyAgent).not.toHaveBeenCalled();
        expect(transport.resolve).not.toHaveBeenCalled();
        expect(transport.dials).toEqual([]);
      } finally {
        socket.terminate();
        agent.destroy();
      }
    },
  );

  it.each([
    { proxied: false, localDnsUnavailable: false, withInstructions: true },
    { proxied: true, localDnsUnavailable: false, withInstructions: true },
    { proxied: true, localDnsUnavailable: true, withInstructions: true },
    { proxied: false, localDnsUnavailable: false, withInstructions: false },
    { proxied: true, localDnsUnavailable: true, withInstructions: false },
  ])(
    "preserves WS deltas (proxy=$proxied, local DNS unavailable=$localDnsUnavailable, instructions=$withInstructions)",
    async ({ proxied, localDnsUnavailable, withInstructions }) => {
      const agent = new Agent();
      const destroy = vi.spyOn(agent, "destroy");
      transport.proxyAgent.mockReturnValue(proxied ? agent : undefined);
      if (localDnsUnavailable) {
        transport.resolve.mockRejectedValue(
          Object.assign(new Error("synthetic local DNS unavailable"), { code: "ENOTFOUND" }),
        );
      }
      const server = createServer();
      const wss = new WebSocketServer({ server });
      const received: unknown[] = [];
      wss.on("headers", (headers) => {
        headers.push(
          "x-codex-turn-state: synthetic-turn-state",
          "x-reasoning-included: true",
          "openai-model: fixture-model",
        );
      });
      wss.on("connection", (socket) => {
        socket.on("message", (data) => {
          if (!Buffer.isBuffer(data)) {
            throw new Error("fixture expected an uncompressed Node WebSocket buffer");
          }
          received.push(JSON.parse(data.toString("utf8")));
          socket.send('{"type":"response.completed","response":{"id":"synthetic-response"}}');
        });
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("fixture did not listen");
      }
      transport.upstream = "ws://127.0.0.1:" + address.port;
      const { proxy, registration, body } = await fixture(withInstructions);
      const socket = new WebSocket(proxy.baseUrl.replace("http:", "ws:") + "/responses");
      let responseHeaders: IncomingHttpHeaders | undefined;
      socket.on("upgrade", (response) => {
        responseHeaders = response.headers;
      });
      try {
        await once(socket, "open");
        expect(responseHeaders).toMatchObject({
          "x-codex-turn-state": "synthetic-turn-state",
          "x-reasoning-included": "true",
          "openai-model": "fixture-model",
        });
        for (const input of [body.input, []]) {
          const response = Promise.race([
            once(socket, "message"),
            once(socket, "close").then(() => {
              throw new Error("inference relay closed before its response");
            }),
          ]);
          socket.send(
            JSON.stringify({
              ...body,
              type: "response.create",
              input,
              previous_response_id: "previous",
            }),
          );
          expect((await response)[0].toString()).toBe(
            '{"type":"response.completed","response":{"id":"synthetic-response"}}',
          );
        }
        const expected = {
          ...body,
          instructions: withInstructions ? "native base\n\nsynthetic persona" : "synthetic persona",
          type: "response.create",
          previous_response_id: "previous",
        };
        expect(received).toEqual([expected, { ...expected, input: [] }]);
        expect(transport.dials).toEqual(["wss://api.openai.com/v1/responses"]);
        expect(transport.resolve).toHaveBeenCalledTimes(proxied ? 0 : 1);
        if (proxied) {
          expect(transport.wsAgents[0] === agent).toBe(true);
          expect(transport.proxyAgent).toHaveBeenCalledWith({
            mode: "env",
            targetUrl: expect.any(String),
          });
        }
        const closed = once(socket, "close");
        registration.release();
        await closed;
        if (proxied) {
          expect(destroy).toHaveBeenCalled();
        }
      } finally {
        socket.terminate();
        proxy.close();
        agent.destroy();
        for (const client of wss.clients) {
          client.terminate();
        }
        await new Promise<void>((resolve) => {
          wss.close(() => resolve());
        });
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    },
  );
});

it("preserves WebSocket connection error headers and body for native auth recovery", async () => {
  const body = JSON.stringify({
    error: { code: "synthetic_auth_expired", message: "refresh native auth" },
  });
  const server = createServer();
  server.on("upgrade", (_req, socket) => {
    socket.end(
      "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nWWW-Authenticate: Bearer synthetic-challenge\r\nRetry-After: 5\r\nContent-Length: " +
        Buffer.byteLength(body) +
        "\r\nConnection: close\r\n\r\n" +
        body,
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture did not listen");
  }
  transport.upstream = "ws://127.0.0.1:" + address.port;
  const { proxy } = await fixture();
  const socket = new WebSocket(proxy.baseUrl.replace("http:", "ws:") + "/responses");
  socket.on("error", () => {});
  try {
    const [, response] = await once(socket, "unexpected-response");
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
      chunks.push(Buffer.from(chunk));
    }
    expect(response.statusCode).toBe(401);
    expect(response.headers).toMatchObject({
      "www-authenticate": "Bearer synthetic-challenge",
      "retry-after": "5",
      "content-type": "application/json",
    });
    expect(Buffer.concat(chunks).toString()).toBe(body);
  } finally {
    socket.terminate();
    proxy.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});
