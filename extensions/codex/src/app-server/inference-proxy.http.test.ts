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
import { createCodexInferenceModelBinding } from "./inference-dispatch.js";
import { createCodexInferenceProxy, type CodexInferenceProxy } from "./inference-proxy.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  createClient,
  createNativeModelSourceFixture,
} from "./native-subagent-monitor.test-support.js";
import { isJsonObject } from "./protocol.js";

const transport = vi.hoisted(() => ({ origin: "" }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) => {
      const source = new URL(params.url);
      expect(source.origin).toBe("https://api.openai.com");
      expect(params).toMatchObject({
        requireHttps: true,
        maxRedirects: 0,
        capture: false,
        mode: "trusted_env_proxy",
      });
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
    proxy.baseUrl + "/responses?cursor=synthetic%2Fa%5Cb%2Ec",
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
  it("replays completed-parent prompt bytes through the HTTP serializer", async () => {
    const received: Buffer[] = [];
    handle = (req, res) => {
      void readBody(req).then((bytes) => {
        received.push(bytes);
        res.end("answer");
      });
    };
    const register = (threadId: string) =>
      proxy.context.register({
        threadId,
        text: "private parent prefix",
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
    const send = async (threadId: string, generation: string, prompt: object) => {
      const upload = post(
        Buffer.from(
          JSON.stringify({
            model: "allowed",
            ...prompt,
            client_metadata: {
              "x-codex-turn-metadata": JSON.stringify({
                thread_id: threadId,
                request_kind: "turn",
                [CODEX_INFERENCE_GENERATION_KEY]: generation,
              }),
            },
          }),
        ),
      );
      const response = await upload.response;
      expect(response.statusCode).toBe(200);
      await readBody(response);
      await upload.closed;
    };
    const parent = register("parent");
    const input = [
      { role: "developer", content: "exact environment λ\n".repeat(16000) },
      { role: "user", content: "parent task" },
      { role: "assistant", content: "previous tool call" },
      { type: "function_call_output", call_id: "call", output: "exact result" },
    ];
    await send("parent", parent.generation, {
      instructions: "native base",
      tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
      input,
    });
    parent.release();
    const fork = proxy.context.fork({
      sourceThreadId: "parent",
      threadId: "fork",
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    const question = { role: "user", content: "side question" };
    const finalAnswer = { role: "assistant", content: "Parent final answer 4837" };
    await send("fork", fork.generation, {
      instructions: "rebuilt base",
      previous_response_id: "child-prewarm-response",
      tools: [],
      input: [...input, finalAnswer, question],
    });
    const [parentBytes, forkBytes] = received;
    if (!parentBytes || !forkBytes) {
      throw new Error("Expected both parent and fork wire requests");
    }
    const parentWire = JSON.parse(parentBytes.toString());
    const forkWire = JSON.parse(forkBytes.toString());
    expect(forkWire.instructions).toBe(parentWire.instructions);
    expect(JSON.stringify(forkWire.tools)).toBe(JSON.stringify(parentWire.tools));
    expect(JSON.stringify(forkWire.input.slice(0, -2))).toBe(JSON.stringify(parentWire.input));
    expect(forkWire.input.at(-2)).toEqual(finalAnswer);
    expect(forkWire.input.at(-1)).toEqual(question);
    expect(forkWire.tool_choice).toBe("none");
    expect(forkWire).not.toHaveProperty("previous_response_id");
    fork.release();
  });

  it.each([false, true])(
    "authorizes a fork after early parent cleanup=%s",
    async (earlyCleanup) => {
      const client = createClient();
      proxy.close();
      proxy = await createCodexInferenceProxy({
        upstream: new URL("https://api.openai.com/v1"),
        assertCurrent: () => {},
        bindModelExecution: createCodexInferenceModelBinding({
          client: client.client,
          provider: "test-provider",
          assertCurrent: () => {},
          memoryConfigured: () => false,
          captureModelSource: codexNativeSubagentMonitorRuntime.captureModelSource,
          resolveModelThreadId: codexNativeSubagentMonitorRuntime.resolveModelThreadId,
        }),
      });
      const parent = proxy.context.register({
        threadId: "parent-thread",
        text: "private parent prefix",
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
      if (earlyCleanup) {
        parent.release();
      }
      const fork = proxy.context.fork({
        sourceThreadId: "parent-thread",
        threadId: "fork-thread",
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
      const source = createNativeModelSourceFixture(["allowed"]);
      const owner = await codexNativeSubagentMonitorRuntime.register({
        client: client.client,
        parentThreadId: "fork-thread",
        modelSource: source,
        configurationQualification: { assertCurrent: () => {}, hasProvider: () => true },
      });
      await owner.ready;
      owner.bindTurn("fork-turn");
      const metadata = {
        session_id: "fork-session",
        thread_id: "fork-thread",
        turn_id: "fork-turn",
        request_kind: "turn",
        [CODEX_INFERENCE_GENERATION_KEY]: fork.generation,
      };
      const body = {
        model: "allowed",
        instructions: "native instructions",
        prompt_cache_key: "parent-session",
        client_metadata: {
          session_id: metadata.session_id,
          turn_id: metadata.turn_id,
          "x-codex-turn-metadata": JSON.stringify(metadata),
        },
      };
      const headers = {
        "session-id": body.prompt_cache_key,
        "thread-id": metadata.thread_id,
        "x-codex-turn-metadata": JSON.stringify(metadata),
      };
      const received = createDeferred<Buffer>();
      handle = (req, res) => {
        void readBody(req).then((bytes) => {
          received.resolve(bytes);
          res.end("fork response");
        }, received.reject);
      };
      try {
        // Parent completion must not revoke the independently admitted fork.
        parent.release();
        const upload = post(Buffer.from(JSON.stringify(body)), headers);
        const response = await upload.response;
        const responseBody = (await readBody(response)).toString();
        expect({ status: response.statusCode, body: responseBody }).toEqual({
          status: 200,
          body: "fork response",
        });
        expect(JSON.parse((await received.promise).toString())).toEqual({
          ...body,
          instructions: "native instructions\n\nprivate parent prefix",
          tool_choice: "none",
        });
        await upload.closed;
        await owner.unregister();
        const revoked = post(Buffer.from(JSON.stringify(body)), headers);
        const denied = await revoked.response;
        expect(denied.statusCode).toBe(403);
        expect((await readBody(denied)).toString()).toContain("cannot verify the owner");
        await revoked.closed;
      } finally {
        fork.release();
        await owner.unregister();
      }
    },
  );

  it("preserves guarded TLS, length, auth and SSE when rewriting zstd requests", async () => {
    const registration = proxy.context.register({
      threadId: "root",
      text: "synthetic root context",
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    const body = {
      instructions: "native instructions",
      input: [{ role: "developer", content: "catalog" }],
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
        expect(new URL(req.url!, transport.origin).searchParams.get("cursor")).toBe(
          "synthetic/a\\b.c",
        );
        expect(req.url?.split("?")[0]).toBe("/v1/responses");
        expect(req.httpVersion).toBe("1.1");
        expect(req.headers["transfer-encoding"]).toBeUndefined();
        expect(req.headers.authorization).toBe("Bearer synthetic-native-auth");
        expect(req.headers).not.toHaveProperty("x-openai-chatpass-test");
        expect(Number(req.headers["content-length"])).toBe(bytes.length);
        received.resolve(zstdDecompressSync(bytes));
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end("data: synthetic completion\n\n");
      }, received.reject);
    };
    const wire = Buffer.from(JSON.stringify(body));
    const upload = post(zstdCompressSync(wire), {
      authorization: "Bearer synthetic-native-auth",
      "content-encoding": "zstd",
    });
    const response = await upload.response;
    expect(response.headers.connection).toBe("close");
    expect((await readBody(response)).toString()).toBe("data: synthetic completion\n\n");
    expect(JSON.parse((await received.promise).toString())).toEqual({
      ...body,
      instructions: "native instructions\n\nsynthetic root context",
    });
    await Promise.all([upload.closed, waitForUpstreamClose()]);
  });

  it("preserves unchanged compressed native request bytes", async () => {
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
        expect(req.headers["content-encoding"]).toBe("zstd");
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
      const wire = zstdCompressSync(source);
      const upload = post(wire, { "content-encoding": "zstd" });
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
