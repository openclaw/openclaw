import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { once } from "node:events";
import { Agent, createServer, request, type IncomingHttpHeaders } from "node:http";
import {
  type ClientOptions,
  WebSocket,
  WebSocketServer,
} from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../../test-support/hanging-loopback-server.js";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import { isTerminalResponse } from "./inference-dispatch.js";
import { createCodexInferenceProxy, type CodexInferenceProxy } from "./inference-proxy.js";
import { createCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";

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
const cleanups: Array<() => void | Promise<void>> = [];
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
afterEach(async () => {
  for (const proxy of proxies.splice(0)) {
    proxy.close();
  }
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

function connect(proxy: CodexInferenceProxy) {
  const socket = new WebSocket(proxy.baseUrl.replace("http:", "ws:") + "/responses");
  cleanups.push(() => socket.terminate());
  return socket;
}

function proxyAgent() {
  const agent = new Agent();
  cleanups.push(() => agent.destroy());
  return agent;
}

async function upstreamFixture(final: string, headers: string[] = []) {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const received: unknown[] = [];
  wss.on("headers", (outgoing) => outgoing.push(...headers));
  wss.on("connection", (socket) => {
    socket.on("message", (bytes) => {
      if (!Buffer.isBuffer(bytes)) {
        throw new Error("fixture expected an uncompressed Node WebSocket buffer");
      }
      received.push(JSON.parse(bytes.toString("utf8")));
      socket.send(final);
    });
  });
  cleanups.push(async () => {
    for (const socket of wss.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  transport.upstream = "ws://127.0.0.1:" + (await listenOnLoopback(server));
  return received;
}

async function rejectedResponse(socket: WebSocket) {
  const [, response] = await once(socket, "unexpected-response");
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(Buffer.from(chunk));
  }
  return { response, text: Buffer.concat(chunks).toString() };
}

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
  bindModelExecution?: Parameters<typeof createCodexInferenceProxy>[0]["bindModelExecution"],
) {
  const proxy = await createCodexInferenceProxy({
    upstream: new URL("https://api.openai.com/v1"),
    assertCurrent: () => {},
    oauth,
    bindModelExecution,
  });
  proxies.push(proxy);
  const controller = new AbortController();
  const registration = await proxy.context.register({
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

it.each(["HTTP", "WebSocket"] as const)(
  "admits a fresh %s assignment after its listener's startup binding lease closes",
  async (kind) => {
    const startupContext = new AsyncLocalStorage<string>();
    const store = createCodexTestBindingStore();
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "synthetic-parent-session",
      sessionKey: "agent:main:synthetic-inference-context",
    };
    const binding = {
      threadId: "root",
      cwd: "/synthetic-workspace",
      appServerRuntimeFingerprint: "synthetic-runtime",
    };
    await store.mutate(identity, { kind: "set", binding });
    const owner = createCodexNativeSubagentHistoryOwner({
      parentThreadId: binding.threadId,
      sessionId: identity.sessionId,
      binding,
    });
    if (!owner) {
      throw new Error("Synthetic binding has no history owner");
    }
    const assignment = {
      runId: "codex-thread:synthetic-child:turn:synthetic-child-turn",
      childThreadId: "synthetic-child",
      nativeTurnId: "synthetic-child-turn",
      nativeParentThreadId: binding.threadId,
      owner,
    };
    let observedStartup: string | undefined;
    const release = vi.fn();
    const bindModelExecution = vi.fn(async () => {
      observedStartup = startupContext.getStore();
      expect(
        await store.mutate(
          identity,
          { kind: "record-native-subagent-assignment", owner, assignment },
          () => {},
        ),
      ).toBe(true);
      return { signal: new AbortController().signal, assertCurrent: () => {}, release };
    });
    const { next, staleWrite } = await startupContext.run("startup lease", () =>
      store.withLease(identity, async () => ({
        next: await fixture(true, undefined, undefined, bindModelExecution),
        staleWrite: AsyncResource.bind(() =>
          store.mutate(identity, {
            kind: "patch",
            threadId: binding.threadId,
            patch: { model: "stale-callback" },
          }),
        ),
      })),
    );
    await expect(staleWrite()).rejects.toThrow("Lost Codex binding lease");
    expect(store.read(identity)).toEqual(binding);
    const final = '{"type":"response.completed","response":{"id":"synthetic-assignment"}}';
    transport.fetch.mockResolvedValue({
      response: new Response(final),
      release: async () => {},
    });
    const forwarded = kind === "WebSocket" ? await upstreamFixture(final) : [];
    let response: string | undefined;
    if (kind === "WebSocket") {
      const socket = connect(next.proxy);
      await once(socket, "open");
      const received = Promise.race([
        once(socket, "message").then(([bytes]) => bytes.toString()),
        once(socket, "close").then(() => undefined),
      ]);
      socket.send(JSON.stringify({ ...next.body, type: "response.create", model: "synthetic" }));
      response = await received;
    } else {
      const result = await post(next.proxy.baseUrl + "/responses", {
        ...next.body,
        model: "synthetic",
      });
      response = await result.text();
    }
    expect(observedStartup).toBeUndefined();
    expect(response).toBe(final);
    expect(bindModelExecution).toHaveBeenCalledOnce();
    expect(await store.readNativeSubagentAssignments?.(identity, owner)).toEqual([assignment]);
    if (kind === "HTTP") {
      expect(transport.fetch).toHaveBeenCalledOnce();
    } else {
      expect(forwarded).toHaveLength(1);
    }
    await expect(staleWrite()).rejects.toThrow("Lost Codex binding lease");
    expect(store.read(identity)).toEqual(binding);
  },
);

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

  it.each(["OAuth grant", "empty context"])(
    "revalidates %s after asynchronous transport preparation",
    async (owner) => {
      const grant = new AbortController();
      const resolve = vi.fn(async () => ({
        token: "synthetic-access",
        assertCurrent: () => grant.signal.throwIfAborted(),
      }));
      const oauth = owner === "OAuth grant";
      const { proxy, controller, body } = await fixture(
        true,
        oauth ? undefined : "",
        oauth ? { resolve } : undefined,
      );
      let writes = 0;
      transport.fetch.mockImplementation(async (args) => {
        (oauth ? grant : controller).abort();
        args.beforeRequest();
        writes++;
        throw new Error("unexpected upstream write");
      });
      expect((await post(proxy.baseUrl + "/responses", body)).status).toBe(502);
      expect(transport.fetch).toHaveBeenCalledTimes(1);
      expect(writes).toBe(0);
    },
  );

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
  it("does not decode ordinary deltas while preserving terminal JSON semantics", () => {
    const parse = vi.spyOn(JSON, "parse");
    try {
      for (const type of ["response.output_text.delta", "response.function_call_arguments.delta"]) {
        expect(isTerminalResponse(Buffer.from(JSON.stringify({ type, delta: "synthetic" })))).toBe(
          false,
        );
      }
      expect(parse).not.toHaveBeenCalled();
      for (const [wire, terminal] of [
        ['{"type":"response.completed","response":{"id":"synthetic"}}', true],
        ['{"type":"response.failed"}', true],
        ['{"type":"response.incomplete"}', true],
        ['{"type":"response.completed"}', false],
        ['{"type":"response.completed","response":{"id":1}}', false],
        ['{"type":"response.failed"', false],
        ['{"type":"response.failed","type":"response.output_text.delta"}', false],
        ['{"nested":{"type":"response.failed"}}', false],
        ['{"type":"delta","delta":"response.failed"}', false],
        ['{"ty\\u0070e":"response.fa\\u0069led"}', true],
        ['{"type":"response.completed","response":{"id":"\\u0061"}}', true],
      ] as const) {
        expect(isTerminalResponse(Buffer.from(wire)), wire).toBe(terminal);
      }
    } finally {
      parse.mockRestore();
    }
  });

  it("rejects WebSocket OAuth without resolving a bearer or dialing upstream", async () => {
    const resolve = vi.fn();
    const { proxy } = await fixture(true, undefined, { resolve });
    const socket = connect(proxy);
    socket.on("error", () => {});
    await once(socket, "error");
    expect(resolve).not.toHaveBeenCalled();
    expect(transport.resolve).not.toHaveBeenCalled();
    expect(transport.dials).toEqual([]);
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
    const socket = connect(proxy);
    socket.on("error", () => {});
    const { response, text } = await rejectedResponse(socket);
    expect(response.statusCode).toBe(502);
    expect(text).toBe(
      "Codex parent-local inference transport failed; retry on a fresh connection.",
    );
    expect(transport.resolve).toHaveBeenCalledOnce();
    expect(transport.proxyAgent).toHaveBeenCalledOnce();
    expect(transport.dials).toEqual([]);
  });

  it("rejects blocked hostnames before proxy or DNS work", async () => {
    const agent = proxyAgent();
    transport.proxyAgent.mockReturnValue(agent);
    const proxy = await createCodexInferenceProxy({
      upstream: new URL("https://service.internal/v1"),
      assertCurrent: () => {},
    });
    proxies.push(proxy);
    const socket = connect(proxy);
    await once(socket, "error");
    expect(transport.proxyAgent).not.toHaveBeenCalled();
    expect(transport.resolve).not.toHaveBeenCalled();
    expect(transport.dials).toEqual([]);
  });

  it.each([
    { proxied: false, localDnsUnavailable: false, withInstructions: true },
    { proxied: true, localDnsUnavailable: true, withInstructions: false },
  ])(
    "preserves WS deltas (proxy=$proxied, local DNS unavailable=$localDnsUnavailable, instructions=$withInstructions)",
    async ({ proxied, localDnsUnavailable, withInstructions }) => {
      const agent = proxyAgent();
      const destroy = vi.spyOn(agent, "destroy");
      transport.proxyAgent.mockReturnValue(proxied ? agent : undefined);
      if (localDnsUnavailable) {
        transport.resolve.mockRejectedValue(
          Object.assign(new Error("synthetic local DNS unavailable"), { code: "ENOTFOUND" }),
        );
      }
      const final = '{"type":"response.completed","response":{"id":"synthetic-response"}}';
      const received = await upstreamFixture(final, [
        "x-codex-turn-state: synthetic-turn-state",
        "x-reasoning-included: true",
        "openai-model: fixture-model",
      ]);
      const { proxy, registration, body } = await fixture(withInstructions);
      const socket = connect(proxy);
      let responseHeaders: IncomingHttpHeaders | undefined;
      socket.on("upgrade", (response) => {
        responseHeaders = response.headers;
      });
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
        const compose = vi.spyOn(AbortSignal, "any");
        try {
          socket.send(wire);
          expect((await response)[0].toString()).toBe(final);
          // Dispatch composes cancellation once; forwarding reuses the admitted signal.
          expect(compose).toHaveBeenCalledTimes(1);
        } finally {
          compose.mockRestore();
        }
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
      }
      const closed = once(socket, "close");
      registration.release();
      await closed;
      if (proxied) {
        expect(destroy).toHaveBeenCalled();
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
  transport.upstream = "ws://127.0.0.1:" + (await listenOnLoopback(server));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  const { proxy } = await fixture();
  const socket = connect(proxy);
  socket.on("error", () => {});
  const { response, text } = await rejectedResponse(socket);
  expect(response.statusCode).toBe(401);
  expect(response.headers).toMatchObject({
    "www-authenticate": "Bearer synthetic-challenge",
    "retry-after": "5",
    "content-type": "application/json",
  });
  expect(text).toBe(body);
});
