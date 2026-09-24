import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { EventEmitter, once } from "node:events";
import {
  request,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { createServer } from "node:https";
import { Socket } from "node:net";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { PROXY_FIXTURE_CERTIFICATE, PROXY_FIXTURE_KEY } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import { createCodexInferenceProxy, type CodexInferenceProxy } from "./inference-proxy.js";
import { isJsonObject } from "./protocol.js";

const transport = vi.hoisted(() => ({ origin: "" }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) => {
      const source = new URL(params.url);
      expect(source.origin).toBe("https://api.openai.com");
      expect(params).toMatchObject({ requireHttps: true, maxRedirects: 0, capture: false });
      const target = new URL(source.pathname + source.search, transport.origin);
      return actual.fetchWithSsrFGuard({
        ...params,
        url: target.href,
        policy: { allowedOrigins: [target.origin], hostnameAllowlist: ["127.0.0.1"] },
        dispatcherPolicy: { mode: "direct", connect: { ca: PROXY_FIXTURE_CERTIFICATE } },
      });
    },
  };
});

let proxy: CodexInferenceProxy;
let server: ReturnType<typeof createServer>;
let handle: RequestListener;
let sockets: Set<Socket>;
let changed: EventEmitter;
const child = {
  client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({
      request_kind: "turn",
      thread_id: "child",
      parent_thread_id: "parent",
    }),
  },
};

beforeEach(async () => {
  sockets = new Set();
  changed = new EventEmitter();
  handle = (_req, res) => res.end("synthetic");
  server = createServer({ key: PROXY_FIXTURE_KEY, cert: PROXY_FIXTURE_CERTIFICATE }, (req, res) =>
    handle(req, res),
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => {
      sockets.delete(socket);
      changed.emit("closed");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  transport.origin = `https://127.0.0.1:${address.port}`;
  proxy = await createCodexInferenceProxy({
    upstream: new URL("https://api.openai.com/v1"),
    assertCurrent: () => {},
  });
  if (process.env.OPENCLAW_VITEST_RUNTIME === "bun") {
    expect(process.versions.bun).toBeTruthy();
  }
});

afterEach(async () => {
  proxy.close();
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  vi.restoreAllMocks();
});

function post(body = Buffer.from(JSON.stringify(child)), headers: Record<string, string> = {}) {
  const response = createDeferred<IncomingMessage>();
  const closed = createDeferred<void>();
  const req = request(
    proxy.baseUrl + "/responses?fixture=1",
    {
      method: "POST",
      agent: false,
      headers,
    },
    response.resolve,
  );
  req.once("error", response.reject);
  req.once("socket", (socket) => {
    socket.once("close", () => closed.resolve());
  });
  req.end(body);
  return { req, response: response.promise, closed: closed.promise };
}

async function readBody(stream: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function waitForUpstreamClose() {
  while (sockets.size > 0) {
    await once(changed, "closed");
  }
}

describe("inference HTTP transport ownership", () => {
  it.each([false, true])(
    "preserves guarded TLS, length, auth and SSE with zstd=%s",
    async (zstd) => {
      const registration = proxy.context.register({
        threadId: "root",
        text: "synthetic root context",
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
      const body = {
        instructions: "native instructions",
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            request_kind: "turn",
            thread_id: "root",
            [CODEX_INFERENCE_GENERATION_KEY]: registration.generation,
          }),
        },
      };
      const received = createDeferred<Buffer>();
      handle = (req, res) => {
        void readBody(req).then((bytes) => {
          expect(req.url).toBe("/v1/responses?fixture=1");
          expect(req.httpVersion).toBe("1.1");
          expect(req.headers["transfer-encoding"]).toBeUndefined();
          expect(req.headers.authorization).toBe("Bearer synthetic-native-auth");
          expect(Number(req.headers["content-length"])).toBe(bytes.length);
          received.resolve(zstd ? zstdDecompressSync(bytes) : bytes);
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end("data: synthetic completion\n\n");
        }, received.reject);
      };
      const wire = Buffer.from(JSON.stringify(body));
      const upload = post(zstd ? zstdCompressSync(wire) : wire, {
        authorization: "Bearer synthetic-native-auth",
        ...(zstd ? { "content-encoding": "zstd" } : {}),
      });
      const response = await upload.response;
      expect(response.headers.connection).toBe("close");
      expect((await readBody(response)).toString()).toBe("data: synthetic completion\n\n");
      expect(JSON.parse((await received.promise).toString())).toEqual({
        ...body,
        instructions: "native instructions\n\nsynthetic root context",
      });
      await Promise.all([upload.closed, waitForUpstreamClose()]);
    },
  );

  it.each([false, true])("preserves unchanged native request bytes with zstd=%s", async (zstd) => {
    const registration = proxy.context.register({
      threadId: "root",
      text: "",
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    let forwarded: Buffer | undefined;
    handle = (req, res) => {
      void readBody(req).then((bytes) => {
        expect(Number(req.headers["content-length"])).toBe(bytes.length);
        expect(req.headers["content-encoding"]).toBe(zstd ? "zstd" : undefined);
        forwarded = bytes;
        res.end("synthetic completion");
      });
    };
    for (const metadata of [
      { request_kind: "turn", thread_id: "child", parent_thread_id: "root" },
      { request_kind: "turn", thread_id: "review", subagent_kind: "review" },
      { request_kind: "compaction" },
      { request_kind: "memory" },
      { request_kind: "prewarm" },
      {
        request_kind: "turn",
        thread_id: "root",
        [CODEX_INFERENCE_GENERATION_KEY]: registration.generation,
      },
    ]) {
      // Native serde keeps integer precision, escape spelling and existing tool JSON.
      const source = Buffer.from(
        '{ "generate": false, "tools": [{ "minimum": 9007199254740993 }], "input": "\\u0061", "client_metadata": ' +
          JSON.stringify({ "x-codex-turn-metadata": JSON.stringify(metadata) }) +
          " }",
      );
      const wire = zstd ? zstdCompressSync(source) : source;
      const upload = post(wire, zstd ? { "content-encoding": "zstd" } : {});
      const response = await upload.response;
      expect(response.statusCode).toBe(200);
      await readBody(response);
      expect(forwarded).toEqual(wire);
      await Promise.all([upload.closed, waitForUpstreamClose()]);
    }
  });

  it("keeps replacement decoding for malformed UTF-8 instead of forwarding invalid bytes", async () => {
    const received = createDeferred<Buffer>();
    handle = (req, res) => {
      void readBody(req).then((bytes) => {
        received.resolve(bytes);
        res.end("synthetic completion");
      }, received.reject);
    };
    const source = Buffer.concat([
      Buffer.from('{"input":"'),
      Buffer.from([0xff]),
      Buffer.from('","client_metadata":' + JSON.stringify(child.client_metadata) + "}"),
    ]);
    const upload = post(source);
    const response = await upload.response;
    expect(response.statusCode).toBe(200);
    await readBody(response);
    expect((await received.promise).toString()).toBe(JSON.stringify(JSON.parse(source.toString())));
    await Promise.all([upload.closed, waitForUpstreamClose()]);
  });

  it("runs a 17th guarded HTTP inference before the first 16 responses complete", async () => {
    const waiting: ServerResponse[] = [];
    const admitted = createDeferred<void>();
    handle = (req, res) => {
      void readBody(req).then(() => {
        waiting.push(res);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: synthetic delta\n\n");
        if (waiting.length === 17) {
          admitted.resolve();
        }
      }, admitted.reject);
    };
    const requests = Array.from({ length: 17 }, () => post());
    await admitted.promise;
    expect(waiting.every((res) => !res.writableEnded)).toBe(true);
    const responses = await Promise.all(requests.map(({ response }) => response));
    const completed = Promise.all(responses.map(readBody));
    for (const response of waiting) {
      response.end("data: synthetic completed\n\n");
    }
    expect((await completed).every((body) => body.includes("synthetic completed"))).toBe(true);
    await Promise.all([...requests.map(({ closed }) => closed), waitForUpstreamClose()]);
    expect(requests.every(({ req }) => req.socket?.closed)).toBe(true);
  });

  it("cancels a backpressured upload after early response headers and drains owned sockets", async (context) => {
    const received = createDeferred<IncomingMessage>();
    const writes = { blocked: 0, drained: 0 };
    let upstreamSocket: Socket | undefined;
    let upstreamErrorObserved = false;
    handle = (req, res) => {
      req.pause();
      res.writeHead(200, { "content-type": "text/event-stream" });
      // The relay exposes downstream headers with the first response body chunk.
      res.write("data: synthetic early delta\n\n");
      received.resolve(req);
    };
    const blocked = createDeferred<Socket>();
    const drained = createDeferred<void>();
    let headersReceived = false;
    const sendHeaders = channel("undici:client:sendHeaders");
    const observe = (message: unknown) => {
      if (
        !isJsonObject(message) ||
        !isJsonObject(message.request) ||
        message.request.origin !== transport.origin ||
        !(message.socket instanceof Socket)
      ) {
        return;
      }
      const socket = message.socket;
      upstreamSocket = socket;
      const write = socket.write.bind(socket);
      vi.spyOn(socket, "write").mockImplementation((...args) => {
        const result = write(...args);
        if (!result) {
          writes.blocked++;
          if (headersReceived) {
            blocked.resolve(socket);
          }
        }
        return result;
      });
      socket.on("drain", () => {
        writes.drained++;
        drained.resolve();
      });
    };
    sendHeaders.subscribe(observe);
    context.onTestFinished(() => {
      sendHeaders.unsubscribe(observe);
    });
    const upload = post(
      Buffer.from(JSON.stringify({ ...child, input: "x".repeat(24 * 1024 * 1024) })),
    );
    const [response, incoming] = await Promise.all([upload.response, received.promise]);
    await drained.promise;
    headersReceived = true;
    if (upstreamSocket?.writableNeedDrain) {
      blocked.resolve(upstreamSocket);
    }
    const upstreamClient = await blocked.promise;
    expect(upstreamClient.writableNeedDrain).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(incoming.readableEnded).toBe(false);
    expect(writes.blocked).toBeGreaterThan(0);
    const upstreamClosed = createDeferred<boolean>();
    upstreamClient.once("error", () => {
      upstreamErrorObserved = true;
    });
    upstreamClient.once("close", upstreamClosed.resolve);
    response.destroy();
    const [, hadError] = await Promise.all([upload.closed, upstreamClosed.promise]);
    expect(upstreamClient.closed).toBe(true);
    if (hadError) {
      expect(upstreamErrorObserved).toBe(true);
    }
    expect(incoming.complete).toBe(false);
    // The deliberately paused peer must consume EOF only after client teardown.
    incoming.resume();
    await waitForUpstreamClose();
    expect(incoming.complete).toBe(false);
    expect(writes.drained).toBeGreaterThan(0);
    expect(upload.req.socket?.closed).toBe(true);
  });
});
