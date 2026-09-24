import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer, request } from "node:http";
import { zstdCompressSync } from "node:zlib";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  type ClientOptions,
  WebSocket,
  WebSocketServer,
} from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { createCodexInferenceProxy, type CodexInferenceProxy } from "./inference-proxy.js";

const transport = vi.hoisted(() => ({
  upstream: "",
  fetch: vi.fn(),
  resolve: vi.fn(),
  downstreams: [] as WebSocket[],
  remotes: [] as WebSocket[],
  servers: [] as ReturnType<typeof createServer>[],
  decompressions: undefined as (() => void)[] | undefined,
  decompressionStarted: undefined as (() => void) | undefined,
  upstreamOptions: undefined as ((options: ClientOptions) => ClientOptions) | undefined,
}));
vi.mock("node:zlib", async (original) => {
  const actual = await original<typeof import("node:zlib")>();
  return {
    ...actual,
    zstdDecompress(...args: Parameters<typeof actual.zstdDecompress>) {
      if (transport.decompressions) {
        transport.decompressions.push(() => actual.zstdDecompress(...args));
        transport.decompressionStarted?.();
      } else {
        actual.zstdDecompress(...args);
      }
    },
  };
});
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
        const upstream = String(url).startsWith("wss:");
        super(
          upstream ? transport.upstream : url,
          upstream ? (transport.upstreamOptions?.(options ?? {}) ?? options) : options,
        );
        if (upstream) {
          transport.remotes.push(this);
        }
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
  transport.remotes = [];
  transport.servers = [];
  transport.decompressions = undefined;
  transport.decompressionStarted = undefined;
  transport.upstreamOptions = undefined;
  clients = [];
  transport.resolve.mockReset().mockResolvedValue({ lookup: undefined });
  transport.fetch.mockReset().mockImplementation(async (args) => {
    await new Response(args.init.body).arrayBuffer();
    return {
      response: new Response("synthetic HTTP response"),
      release: async () => {},
    };
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
  const blocked = transport.decompressions;
  transport.decompressions = undefined;
  for (const finish of blocked ?? []) {
    finish();
  }
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
  const remote = transport.remotes.at(-1);
  assert(remote);
  return { client, upstream, remote };
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
async function post(signal?: AbortSignal, compressed = false) {
  return await new Promise<{ status?: number; retryAfter?: string; body: string }>(
    (resolve, reject) => {
      const req = request(
        proxy.baseUrl + "/responses",
        {
          method: "POST",
          agent: false,
          signal,
          ...(compressed ? { headers: { "content-encoding": "zstd" } } : {}),
        },
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
      const bytes = Buffer.from(JSON.stringify(child));
      req.end(compressed ? zstdCompressSync(bytes) : bytes);
    },
  );
}

function relayServer() {
  const relay = transport.servers.at(-1);
  assert(relay);
  return relay;
}

async function holdUploads() {
  const streams = [];
  for (let index = 0; index < 16; index++) {
    const stream = await open();
    const nativeSend = stream.remote.send.bind(stream.remote);
    const drained = createDeferred<() => void>();
    vi.spyOn(stream.remote, "send").mockImplementation((data, options, callback) => {
      nativeSend(data, options, (error) => {
        drained.resolve(() => callback?.(error));
      });
    });
    await send(stream.client, stream.upstream);
    const releaseUpload = await drained.promise;
    streams.push({ ...stream, releaseUpload });
  }
  return streams;
}

function holdHttpResponses() {
  const arrived = new EventEmitter();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  transport.fetch.mockImplementation(async (args) => {
    await new Response(args.init.body).arrayBuffer();
    return {
      response: new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.push(controller);
            controller.enqueue(new TextEncoder().encode("synthetic delta"));
            arrived.emit("request");
          },
        }),
      ),
      release: async () => {},
    };
  });
  return {
    streams,
    async waitFor(count: number) {
      while (streams.length < count) {
        await once(arrived, "request");
      }
    },
  };
}

export {
  child,
  clients,
  complete,
  connect,
  holdHttpResponses,
  holdUploads,
  open,
  post,
  prewarm,
  proxy,
  relayServer,
  send,
  server,
  transport,
  upstreams,
};
