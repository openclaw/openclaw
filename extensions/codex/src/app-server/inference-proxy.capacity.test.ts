import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  type ClientOptions,
  WebSocket,
  WebSocketServer,
} from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import { createCodexInferenceProxy, type CodexInferenceProxy } from "./inference-proxy.js";

const transport = vi.hoisted(() => ({
  upstream: "",
  fetch: vi.fn(),
  resolve: vi.fn(),
  downstreams: [] as WebSocket[],
}));
vi.mock("openclaw/plugin-sdk/fetch-runtime", () => ({ createNodeProxyAgent: () => undefined }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: transport.fetch,
  isBlockedHostnameOrIp: () => false,
  resolvePinnedHostnameWithPolicy: transport.resolve,
}));
vi.mock("openclaw/plugin-sdk/websocket-runtime", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/websocket-runtime")>();
  return {
    ...actual,
    WebSocketServer: class extends actual.WebSocketServer {
      override handleUpgrade(
        ...[incomingRequest, socket, head, callback]: Parameters<
          InstanceType<typeof actual.WebSocketServer>["handleUpgrade"]
        >
      ) {
        super.handleUpgrade(incomingRequest, socket, head, (client, incoming) => {
          if (this.options.noServer) {
            transport.downstreams.push(client);
          }
          callback(client, incoming);
        });
      }
    },
    WebSocket: class extends actual.WebSocket {
      constructor(url: string | URL, options?: ClientOptions) {
        super(String(url).startsWith("wss:") ? transport.upstream : url, options);
      }
    },
  };
});

const completed = '{"type":"response.completed","response":{"id":"synthetic"}}';
const prewarm = {
  type: "response.create",
  generate: false,
  client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ thread_id: "fixture", request_kind: "prewarm" }),
  },
};
const child = {
  type: "response.create",
  client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: "child",
      parent_thread_id: "parent",
      request_kind: "turn",
    }),
  },
};
let proxy: CodexInferenceProxy;
let server: ReturnType<typeof createServer>;
let wss: WebSocketServer;
let upstreams: WebSocket[];
let clients: WebSocket[];

beforeEach(async () => {
  upstreams = [];
  transport.downstreams = [];
  clients = [];
  transport.resolve.mockReset().mockResolvedValue({ lookup: undefined });
  transport.fetch.mockReset().mockResolvedValue({
    response: new Response("synthetic HTTP response"),
    release: async () => {},
  });
  server = createServer();
  wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => upstreams.push(socket));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture did not listen");
  }
  transport.upstream = "ws://127.0.0.1:" + address.port;
  proxy = await createCodexInferenceProxy({
    upstream: new URL("https://api.openai.com/v1"),
    assertCurrent: () => {},
  });
});
afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients) {
    client.terminate();
  }
  proxy.close();
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

function connect() {
  const client = new WebSocket(proxy.baseUrl.replace("http:", "ws:") + "/responses");
  client.on("error", () => {});
  clients.push(client);
  return client;
}
async function open() {
  const client = connect();
  await once(client, "open");
  const upstream = upstreams.at(-1);
  if (!upstream) {
    throw new Error("fixture did not accept its upstream");
  }
  return { client, upstream };
}
async function send(client: WebSocket, upstream: WebSocket, body = child) {
  const received = once(upstream, "message");
  client.send(JSON.stringify(body));
  await received;
}
async function complete(client: WebSocket, upstream: WebSocket, frame = completed) {
  const received = once(client, "message");
  upstream.send(frame);
  expect((await received)[0].toString()).toBe(frame);
}
async function post() {
  return await new Promise<{ status?: number; retryAfter?: string; body: string }>(
    (resolve, reject) => {
      const req = request(proxy.baseUrl + "/responses", { method: "POST", agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            retryAfter: res.headers["retry-after"],
            body: Buffer.concat(chunks).toString(),
          }),
        );
      });
      req.on("error", reject);
      req.end(JSON.stringify(child));
    },
  );
}

describe("inference relay capacity", () => {
  it("admits new root, child and HTTP fallback after 16 completed prewarm connections", async () => {
    for (let index = 0; index < 16; index++) {
      const { client, upstream } = await open();
      await send(client, upstream, prewarm);
      await complete(client, upstream);
    }
    expect((await post()).status).toBe(200);
    const { client, upstream } = await open();
    const registration = proxy.context.register({
      threadId: "root",
      text: "synthetic persona",
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    await send(client, upstream, {
      type: "response.create",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "root",
          request_kind: "turn",
          [CODEX_INFERENCE_GENERATION_KEY]: registration.generation,
        }),
      },
    });
    await complete(client, upstream);
    const childStream = await open();
    await send(childStream.client, childStream.upstream);
    await complete(childStream.client, childStream.upstream);
    expect(clients.every((socket) => socket.readyState === WebSocket.OPEN)).toBe(true);
  });

  it.each(["response.completed", "response.failed", "response.incomplete"])(
    "returns retryable overload without interrupting streams and reclaims a slot on %s",
    async (type) => {
      const streams = [];
      for (let index = 0; index < 16; index++) {
        const stream = await open();
        await send(stream.client, stream.upstream);
        streams.push(stream);
      }
      const overloaded = await post();
      expect(overloaded).toMatchObject({ status: 503, retryAfter: "1" });
      expect(JSON.parse(overloaded.body)).toMatchObject({
        status: 503,
        error: { code: "inference_relay_busy" },
      });
      expect(transport.fetch).not.toHaveBeenCalled();
      const rejected = await open();
      const error = once(rejected.client, "message");
      rejected.client.send(JSON.stringify(child));
      expect(JSON.parse((await error)[0].toString())).toMatchObject({
        type: "error",
        status: 503,
        error: { code: "inference_relay_busy" },
      });
      expect(streams.every(({ client }) => client.readyState === WebSocket.OPEN)).toBe(true);
      const first = streams[0];
      assert(first);
      await complete(
        first.client,
        first.upstream,
        JSON.stringify({ type, response: { id: "synthetic" } }),
      );
      expect((await post()).status).toBe(200);
      await send(first.client, first.upstream);
      await complete(first.client, first.upstream);
    },
  );

  it("shares the request budget with streaming HTTP and releases it at response completion", async () => {
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const admitted = createDeferred<void>();
    transport.fetch.mockImplementation(async () => ({
      response: new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.push(controller);
            if (streams.length === 16) {
              admitted.resolve();
            }
            controller.enqueue(new TextEncoder().encode("synthetic HTTP delta"));
          },
        }),
      ),
      release: async () => {},
    }));
    const responses = Array.from({ length: 16 }, () => post());
    await admitted.promise;
    const rejected = await open();
    const error = once(rejected.client, "message");
    rejected.client.send(JSON.stringify(child));
    expect(JSON.parse((await error)[0].toString()).status).toBe(503);
    const firstStream = streams[0];
    const firstResponse = responses[0];
    assert(firstStream);
    assert(firstResponse);
    firstStream.close();
    expect((await firstResponse).status).toBe(200);
    const replacement = await open();
    await send(replacement.client, replacement.upstream);
    await complete(replacement.client, replacement.upstream);
    for (const stream of streams.slice(1)) {
      stream.close();
    }
    expect((await Promise.all(responses)).every((response) => response.status === 200)).toBe(true);
  });

  it("reclaims the oldest idle transport immediately when its pool is full", async () => {
    for (let index = 0; index < 64; index++) {
      await open();
    }
    const oldest = clients[0];
    assert(oldest);
    const closed = once(oldest, "close");
    const replacement = await open();
    await closed;
    await send(replacement.client, replacement.upstream);
    await complete(replacement.client, replacement.upstream);
    expect(clients.slice(1).every((client) => client.readyState === WebSocket.OPEN)).toBe(true);
    expect((await post()).status).toBe(200);
  });

  it("does not evict a completed response until its final frame has drained", async () => {
    const active = await open();
    await send(active.client, active.upstream);
    const downstream = transport.downstreams[0];
    assert(downstream);
    const nativeSend = downstream.send.bind(downstream);
    let drained: (() => void) | undefined;
    vi.spyOn(downstream, "send").mockImplementation((data, options, callback) => {
      nativeSend(data, options, (error) => {
        drained = () => callback?.(error);
      });
    });
    await complete(active.client, active.upstream);
    for (let index = 0; index < 63; index++) {
      await open();
    }
    const oldestIdle = clients[1];
    assert(oldestIdle);
    const evicted = Promise.race([
      once(active.client, "close").then(() => "active"),
      once(oldestIdle, "close").then(() => "idle"),
    ]);
    await open();
    expect(await evicted).toBe("idle");
    expect(active.client.readyState).toBe(WebSocket.OPEN);
    expect(drained).toBeTypeOf("function");
    drained?.();
  });

  it("bounds pending handshakes with a retryable rejection while preserving HTTP fallback", async () => {
    const pending: (() => void)[] = [];
    const admitted = createDeferred<void>();
    transport.resolve.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve({ lookup: undefined }));
          if (pending.length === 64) {
            admitted.resolve();
          }
        }),
    );
    const opened = Array.from({ length: 64 }, () => once(connect(), "open"));
    await admitted.promise;
    const rejected = connect();
    const [, response] = await once(rejected, "unexpected-response");
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
      chunks.push(Buffer.from(chunk));
    }
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
    expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({
      status: 503,
      error: { code: "inference_relay_busy" },
    });
    expect((await post()).status).toBe(200);
    expect(upstreams).toHaveLength(0);
    for (const resolve of pending) {
      resolve();
    }
    await Promise.all(opened);
    expect(upstreams).toHaveLength(64);
  });

  it("expires only proven idle connections, not active streams, then admits their replacements", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const idle = await open();
    await send(idle.client, idle.upstream, prewarm);
    await complete(idle.client, idle.upstream);
    const active = await open();
    await send(active.client, active.upstream);
    await complete(active.client, active.upstream, '{"type":"response.completed"}');
    await complete(active.client, active.upstream, '{"type":"error","message":"unknown event"}');
    const closed = once(idle.client, "close");
    await vi.advanceTimersByTimeAsync(60_000);
    await closed;
    expect(active.client.readyState).toBe(WebSocket.OPEN);
    await complete(
      active.client,
      active.upstream,
      '{"type":"response.output_text.delta","delta":"alive"}',
    );
    const replacement = await open();
    await send(replacement.client, replacement.upstream);
    await complete(replacement.client, replacement.upstream);
    await complete(active.client, active.upstream);
  });
});
