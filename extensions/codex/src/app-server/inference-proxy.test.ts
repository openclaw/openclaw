import { once } from "node:events";
import { Agent, createServer, request, type IncomingHttpHeaders } from "node:http";
import {
  type ClientOptions,
  WebSocket,
  WebSocketServer,
} from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("openclaw/plugin-sdk/websocket-runtime", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/websocket-runtime")>();
  return {
    ...actual,
    WebSocket: class extends actual.WebSocket {
      constructor(url: string | URL, options?: ClientOptions) {
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

async function post(url: string, body: unknown, headers?: Record<string, string>) {
  if (new URL(url).hostname !== "127.0.0.1") {
    throw new Error("fixture requires its own loopback server");
  }
  return await new Promise<{ status: number | undefined; text: () => Promise<string> }>(
    (resolve, reject) => {
      const req = request(url, { method: "POST", headers, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.once("error", reject);
        res.once("end", () =>
          resolve({ status: res.statusCode, text: async () => Buffer.concat(chunks).toString() }),
        );
      });
      req.once("error", reject);
      req.end(JSON.stringify(body));
    },
  );
}

async function fixture(
  withInstructions = true,
  contextText = "synthetic persona",
  oauth?: Parameters<typeof createCodexInferenceProxy>[0]["oauth"],
) {
  const proxy = await createCodexInferenceProxy({
    upstream: new URL("https://api.openai.com/v1"),
    assertCurrent: () => {},
    oauth,
  });
  proxies.push(proxy);
  const controller = new AbortController();
  const registration = proxy.context.register({
    threadId: "root",
    text: contextText,
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
  it("resolves host OAuth only for admitted Responses requests and refreshes once after 401", async () => {
    const resolve = vi.fn(async (forceRefresh: boolean) => ({
      token: forceRefresh ? "synthetic-refreshed" : "synthetic-access",
      assertCurrent: () => {},
    }));
    const { proxy, body } = await fixture(true, undefined, { resolve });
    transport.fetch.mockImplementation(async (args) => {
      args.beforeRequest();
      const bytes = await new Response(args.init.body).text();
      expect(JSON.parse(bytes).instructions).toBe("native base\n\nsynthetic persona");
      const first = args.init.headers.authorization === "Bearer synthetic-access";
      expect(args.init.headers).not.toHaveProperty("chatgpt-account-id");
      expect(args.init.headers).not.toHaveProperty("openai-organization");
      expect(args.init.headers).not.toHaveProperty("openai-project");
      return {
        response: new Response(first ? "expired" : "data: completed\n\n", {
          status: first ? 401 : 200,
        }),
        release: async () => {},
      };
    });
    for (const path of ["/models", "/responses/compact", "/responses?other=1"]) {
      expect((await post(proxy.baseUrl + path, body)).status).toBe(502);
    }
    expect(resolve).not.toHaveBeenCalled();
    const result = await post(proxy.baseUrl + "/responses", body, {
      authorization: "Bearer local-placeholder",
      "chatgpt-account-id": "native-account",
      "openai-project": "native-project",
      "openai-organization": "native-org",
      "X-OpenAI-ChatPass-Test": "stale",
    });
    expect(result.status).toBe(200);
    expect(await result.text()).toBe("data: completed\n\n");
    expect(resolve.mock.calls).toEqual([[false], [true]]);
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    expect(
      transport.fetch.mock.calls.map(([args]) => args.init.headers["x-openai-chatpass-test"]),
    ).toEqual(["codex-direct", "codex-direct"]);
    expect(transport.fetch.mock.calls[1]?.[0].init.headers.authorization).toBe(
      "Bearer synthetic-refreshed",
    );
  });

  it("rejects OAuth use after refresh loses the admitted turn and before physical I/O loses the grant", async () => {
    let loseAdmission = true;
    let grantCurrent = true;
    const resolve = vi.fn(async () => {
      if (loseAdmission) {
        registration.release();
      }
      return {
        token: "synthetic-access",
        assertCurrent: () => {
          if (!grantCurrent) {
            throw new Error("revoked");
          }
        },
      };
    });
    const { proxy, body, registration } = await fixture(true, undefined, { resolve });
    expect((await post(proxy.baseUrl + "/responses", body)).status).toBe(502);
    expect(transport.fetch).not.toHaveBeenCalled();
    loseAdmission = false;
    const next = await fixture(true, undefined, { resolve });
    let writes = 0;
    transport.fetch.mockImplementation(async (args) => {
      grantCurrent = false;
      args.beforeRequest();
      writes++;
      throw new Error("unexpected upstream write");
    });
    expect((await post(next.proxy.baseUrl + "/responses", next.body)).status).toBe(502);
    expect(writes).toBe(0);
  });

  it("rejects unadmitted native prewarm for OAuth", async () => {
    const resolve = vi.fn();
    const { proxy } = await fixture(true, undefined, { resolve });
    const body = {
      generate: false,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ request_kind: "prewarm" }) },
    };
    expect((await post(proxy.baseUrl + "/responses", body)).status).toBe(502);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("authorizes automatic compaction only with the current admitted generation", async () => {
    const resolve = vi.fn(async () => ({ token: "synthetic-access", assertCurrent: () => {} }));
    const { proxy, body, registration } = await fixture(true, undefined, { resolve });
    const compaction = {
      ...body,
      client_metadata: {
        thread_id: "root",
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "root",
          request_kind: "compaction",
          [CODEX_INFERENCE_GENERATION_KEY]: registration.generation,
        }),
      },
    };
    transport.fetch.mockImplementation(async (args) => {
      args.beforeRequest();
      expect(JSON.parse(await new Response(args.init.body).text()).instructions).toBe(
        "native base",
      );
      return { response: new Response("data: summary\n\n"), release: async () => {} };
    });
    expect((await post(proxy.baseUrl + "/responses", compaction)).status).toBe(200);
    registration.release();
    expect((await post(proxy.baseUrl + "/responses", compaction)).status).toBe(502);
    expect(resolve).toHaveBeenCalledOnce();
  });
  it("rejects missing private route authority and stale admitted generation without an upstream call", async () => {
    const { proxy, registration, body } = await fixture();
    const unknownRoute = new URL(proxy.baseUrl).origin + "/responses";
    const response = await post(unknownRoute, body);
    expect(response.status).toBe(502);
    registration.release();
    const stale = await post(proxy.baseUrl + "/responses", body);
    expect(stale.status).toBe(502);
    expect(await stale.text()).not.toContain("synthetic persona");
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it("revalidates admission after asynchronous preparation without a context rewrite", async () => {
    const { proxy, controller, body } = await fixture(true, "");
    let writes = 0;
    transport.fetch.mockImplementation(async (args) => {
      controller.abort();
      args.beforeRequest();
      writes++;
      throw new Error("must not reach the upstream");
    });
    const response = await post(proxy.baseUrl + "/responses", body);
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
    const response = await post(proxy.baseUrl + "/responses", body);
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("native unauthorized");
  });
});

describe("private inference WebSocket relay", () => {
  it("rejects WebSocket OAuth without resolving a bearer or dialing upstream", async () => {
    const resolve = vi.fn();
    const { proxy } = await fixture(true, undefined, { resolve });
    const socket = new WebSocket(proxy.baseUrl.replace("http:", "ws:") + "/responses");
    socket.on("error", () => {});
    try {
      await once(socket, "error");
      expect(resolve).not.toHaveBeenCalled();
      expect(transport.resolve).not.toHaveBeenCalled();
      expect(transport.dials).toEqual([]);
    } finally {
      socket.terminate();
    }
  });
  it("rejects private destination DNS on a direct WebSocket route", async () => {
    const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
      "openclaw/plugin-sdk/ssrf-runtime",
    );
    transport.resolve.mockImplementation((hostname: string, options: { signal?: AbortSignal }) =>
      actual.resolvePinnedHostnameWithPolicy(hostname, {
        ...options,
        lookupFn: async () => [{ address: "127.0.0.1", family: 4 }],
      }),
    );
    const { proxy } = await fixture();
    const socket = new WebSocket(proxy.baseUrl.replace("http:", "ws:") + "/responses");
    socket.on("error", () => {});
    try {
      const [, response] = await once(socket, "unexpected-response");
      const chunks: Buffer[] = [];
      for await (const chunk of response) {
        chunks.push(Buffer.from(chunk));
      }
      expect(response.statusCode).toBe(502);
      expect(Buffer.concat(chunks).toString()).toBe(
        "Codex parent-local inference transport failed; retry on a fresh connection.",
      );
      expect(transport.resolve).toHaveBeenCalledOnce();
      expect(transport.proxyAgent).toHaveBeenCalledOnce();
      expect(transport.dials).toEqual([]);
    } finally {
      socket.terminate();
    }
  });

  it("returns a complete sanitized rejection when upstream closes before upgrading", async () => {
    const server = createServer();
    server.on("upgrade", (_request, socket) => socket.destroy());
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
      expect(response.statusCode).toBe(502);
      expect(Buffer.concat(chunks).toString()).toBe(
        "Codex parent-local inference transport failed; retry on a fresh connection.",
      );
    } finally {
      socket.terminate();
      proxy.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("rejects blocked hostnames before proxy or DNS work", async () => {
    const agent = new Agent();
    transport.proxyAgent.mockReturnValue(agent);
    const proxy = await createCodexInferenceProxy({
      upstream: new URL("https://service.internal/v1"),
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
  });

  it.each([
    { proxied: false, localDnsUnavailable: false, withInstructions: true },
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
          const wire = JSON.stringify(
            {
              ...body,
              type: "response.create",
              input,
              previous_response_id: "previous",
            },
            null,
            2,
          );
          socket.send(wire);
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
