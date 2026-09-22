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
  servers: [] as ReturnType<typeof createServer>[],
}));
vi.mock("node:http", async (original) => {
  const actual = await original<typeof import("node:http")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof createServer>) => {
      const server = actual.createServer(...args);
      transport.servers.push(server);
      return server;
    },
  };
});
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
  transport.servers = [];
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
async function post(signal?: AbortSignal) {
  return await new Promise<{ status?: number; retryAfter?: string; body: string }>(
    (resolve, reject) => {
      const req = request(
        proxy.baseUrl + "/responses",
        { method: "POST", agent: false, signal },
        (res) => {
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
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(child));
    },
  );
}

function relayServer() {
  const relay = transport.servers.at(-1);
  assert(relay);
  return relay;
}

async function fillCapacity() {
  const streams = [];
  for (let index = 0; index < 16; index++) {
    const stream = await open();
    await send(stream.client, stream.upstream);
    streams.push(stream);
  }
  return streams;
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
    "queues HTTP and a new handshake without interrupting streams, then reclaims on %s",
    async (type) => {
      const streams = await fillCapacity();
      const received = once(relayServer(), "request");
      const queuedHttp = post();
      await received;
      expect(transport.fetch).not.toHaveBeenCalled();
      const upgrade = once(relayServer(), "upgrade");
      const queuedSocket = connect();
      const opened = once(queuedSocket, "open");
      await upgrade;
      expect(upstreams).toHaveLength(16);
      expect(transport.resolve).toHaveBeenCalledTimes(16);
      expect(streams.every(({ client }) => client.readyState === WebSocket.OPEN)).toBe(true);
      const first = streams[0];
      assert(first);
      await complete(
        first.client,
        first.upstream,
        JSON.stringify({ type, response: { id: "synthetic" } }),
      );
      expect((await queuedHttp).status).toBe(200);
      await opened;
      const nextUpstream = upstreams.at(-1);
      assert(nextUpstream);
      await send(queuedSocket, nextUpstream);
      await complete(queuedSocket, nextUpstream);
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
    const upgrade = once(relayServer(), "upgrade");
    const queued = connect();
    const opened = once(queued, "open");
    await upgrade;
    expect(upstreams).toHaveLength(0);
    const firstStream = streams[0];
    const firstResponse = responses[0];
    assert(firstStream);
    assert(firstResponse);
    firstStream.close();
    expect((await firstResponse).status).toBe(200);
    await opened;
    const upstream = upstreams.at(-1);
    assert(upstream);
    await send(queued, upstream);
    await complete(queued, upstream);
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

  it("bounds pending handshakes before dialing and drains without leaking permits", async () => {
    const pending: (() => void)[] = [];
    const admitted = createDeferred<void>();
    transport.resolve.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve({ lookup: undefined }));
          if (pending.length === 16) {
            admitted.resolve();
          }
        }),
    );
    let upgrades = 0;
    const queued = createDeferred<void>();
    relayServer().on("upgrade", () => {
      if (++upgrades === 32) {
        queued.resolve();
      }
    });
    const opened = Array.from({ length: 32 }, () => once(connect(), "open"));
    await admitted.promise;
    await queued.promise;
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
    expect(upstreams).toHaveLength(0);
    transport.resolve.mockResolvedValue({ lookup: undefined });
    for (const resolve of pending) {
      resolve();
    }
    await Promise.all(opened);
    expect(upstreams).toHaveLength(32);
    expect((await post()).status).toBe(200);
  });

  it("expires a queued handshake before native connect timeout without dialing upstream", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await fillCapacity();
    const upgrade = once(relayServer(), "upgrade");
    const queued = connect();
    const rejected = once(queued, "unexpected-response");
    await upgrade;
    await vi.advanceTimersByTimeAsync(10_000);
    const [, response] = await rejected;
    response.resume();
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
    expect(transport.resolve).toHaveBeenCalledTimes(16);
    expect(upstreams).toHaveLength(16);
  });

  it("bounds queued HTTP work, cancels waiters, and admits a later request", async () => {
    const streams = await fillCapacity();
    const controllers = Array.from({ length: 16 }, () => new AbortController());
    const waiting = [];
    const disconnected = [];
    for (const controller of controllers) {
      const received = once(relayServer(), "request");
      waiting.push(post(controller.signal).catch(() => undefined));
      const [incoming] = await received;
      disconnected.push(once(incoming.socket, "close"));
    }
    expect(await post()).toMatchObject({ status: 503, retryAfter: "1" });
    for (const controller of controllers) {
      controller.abort();
    }
    await Promise.all([...waiting, ...disconnected]);
    const first = streams[0];
    assert(first);
    await complete(first.client, first.upstream);
    expect((await post()).status).toBe(200);
    expect(transport.fetch).toHaveBeenCalledOnce();
  });

  it("cancels a queued handshake on peer FIN before capacity becomes available", async () => {
    const streams = await fillCapacity();
    const upgrade = once(relayServer(), "upgrade");
    const queued = connect();
    const [, socket] = await upgrade;
    const ended = once(socket, "end");
    queued.terminate();
    await ended;
    const first = streams[0];
    assert(first);
    await complete(first.client, first.upstream);
    // HTTP admission is a FIFO barrier after the cancelled handshake's slot.
    expect((await post()).status).toBe(200);
    expect(transport.resolve).toHaveBeenCalledTimes(16);
    expect(socket.destroyed).toBe(true);
  });

  it.each(["generation revoked", "duplicate frame"])(
    "releases queued work after %s without forwarding it or blocking the next frame",
    async (cause) => {
      const stale = await open();
      const next = await open();
      const streams = await fillCapacity();
      const registration = proxy.context.register({
        threadId: "root",
        text: "synthetic persona",
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
      const staleReceived = once(transport.downstreams[0]!, "message");
      stale.client.send(
        JSON.stringify({
          type: "response.create",
          client_metadata: {
            "x-codex-turn-metadata": JSON.stringify({
              thread_id: "root",
              request_kind: "turn",
              [CODEX_INFERENCE_GENERATION_KEY]: registration.generation,
            }),
          },
        }),
      );
      await staleReceived;
      const staleForwarded = vi.fn();
      stale.upstream.on("message", staleForwarded);
      const closed = once(stale.client, "close");
      if (cause === "generation revoked") {
        registration.release();
      } else {
        stale.client.send(JSON.stringify(child));
      }
      await closed;
      const nextReceived = once(transport.downstreams[1]!, "message");
      const forwarded = once(next.upstream, "message");
      next.client.send(JSON.stringify(child));
      await nextReceived;
      const first = streams[0];
      assert(first);
      await complete(first.client, first.upstream);
      await forwarded;
      expect(staleForwarded).not.toHaveBeenCalled();
      await complete(next.client, next.upstream);
    },
  );

  it("expires admission during DNS and cancels a late dial without leaking the permit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const started = createDeferred<void>();
    const dns = createDeferred<{ lookup: undefined }>();
    transport.resolve.mockImplementationOnce(() => {
      started.resolve();
      return dns.promise;
    });
    const stalled = connect();
    const closed = new Promise<void>((resolve) => {
      stalled.once("close", () => resolve());
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    await closed;
    dns.resolve({ lookup: undefined });
    const streams = await fillCapacity();
    expect(upstreams).toHaveLength(16);
    expect(streams.every(({ client }) => client.readyState === WebSocket.OPEN)).toBe(true);
  });

  it("bounds queued frame bytes and recovers after disconnect", async () => {
    const large = await open();
    const excess = await open();
    const streams = await fillCapacity();
    const body = JSON.stringify({ ...child, input: "x".repeat(17 * 1024 * 1024) });
    const received = once(transport.downstreams[0]!, "message");
    large.client.send(body);
    await received;
    const rejected = once(excess.client, "message");
    excess.client.send(body);
    expect(JSON.parse((await rejected)[0].toString())).toMatchObject({ status: 503 });
    const closed = once(transport.downstreams[0]!, "close");
    large.client.terminate();
    await closed;
    const first = streams[0];
    assert(first);
    await complete(first.client, first.upstream);
    expect((await post()).status).toBe(200);
  });

  it.each(["upgrade", "error body"])(
    "expires a stalled upstream %s and reclaims admission",
    async (phase) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const handlers = server.listeners("upgrade");
      server.removeAllListeners("upgrade");
      const received = createDeferred<void>();
      const disconnected = createDeferred<void>();
      server.once("upgrade", (_request, socket) => {
        socket.once("close", () => disconnected.resolve());
        // Raw HTTP-upgrade sockets retain a writable half after peer FIN.
        socket.once("end", () => socket.end());
        socket.on("error", (error) => expect(error).toMatchObject({ code: "ECONNRESET" }));
        if (phase === "error body") {
          socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 1000\r\n\r\nx");
        }
        received.resolve();
      });
      const stalled = connect();
      const closed = new Promise<void>((resolve) => {
        stalled.once("close", () => resolve());
      });
      await received.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all([closed, disconnected.promise]);
      for (const handler of handlers) {
        server.on("upgrade", handler);
      }
      expect(await fillCapacity()).toHaveLength(16);
    },
  );

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
