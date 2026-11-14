import { once } from "node:events";
import http from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collect } from "../../../test/helpers/async-iterable.js";
import type { Context, Model, Usage } from "../../llm/types.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { createUsageFixture } from "../test-helpers/usage-fixtures.js";
import { streamProxy, type ProxyStreamOptions } from "./proxy.js";

const usage: Usage = createUsageFixture(1, 2, 3);

const model: Model = makeProviderModelFixture({
  id: "test-model",
  provider: "test",
  api: "openai-responses",
  baseUrl: "https://example.test",
});

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

const proxyOptions = { authToken: "token", proxyUrl: "https://proxy.example" };
const done = { type: "done", reason: "stop", usage };

function stubResponse(response: Response) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function startStream(response: Response, options: Partial<ProxyStreamOptions> = {}) {
  stubResponse(response);
  return streamProxy(model, context, { ...proxyOptions, ...options });
}

function requestBody(fetchMock: ReturnType<typeof stubResponse>) {
  const rawBody = fetchMock.mock.calls[0]?.[1]?.body;
  expect(typeof rawBody).toBe("string");
  return JSON.parse(rawBody as string) as {
    model?: { headers?: unknown };
    options?: { headers?: unknown; promptCacheKey?: string; sessionId?: string };
  };
}

function sseFrame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function responseFromText(text: string): Response {
  return new Response(new TextEncoder().encode(text));
}

function responseFromSseFrames(frames: unknown[]): Response {
  return readerResponse(frames.map(sseFrame), { beforeRead: nextTurn });
}

const unresolved = Symbol("unresolved stream result");

function readerResponse(
  texts: string[],
  {
    pending = false,
    status = 200,
    statusText = "OK",
    beforeRead = async () => {},
    cancel = async (_reason?: unknown) => {},
    releaseLock = () => {},
  } = {},
): Response {
  const chunks = texts.map((text) => new TextEncoder().encode(text));
  const reader = {
    read: async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      await beforeRead();
      const value = chunks.shift();
      return value
        ? { done: false, value }
        : pending
          ? new Promise(() => {})
          : { done: true, value: undefined };
    },
    cancel,
    releaseLock,
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    body: { getReader: () => reader },
  } as Response;
}

async function resultWithinMs(
  stream: { result(): Promise<unknown> },
  timeoutMs = 25,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      stream.result(),
      new Promise<symbol>((resolve) => {
        timer = setTimeout(() => resolve(unresolved), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function settledResult(stream: { result(): Promise<unknown> }): Promise<unknown> {
  return await Promise.race([stream.result(), Promise.resolve(unresolved)]);
}

describe("streamProxy", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("accepts data lines without a space after the colon", async () => {
    const proxyEvents = [
      { type: "text_start", contentIndex: 0, contentSignature: "sig" },
      { type: "text_delta", contentIndex: 0, delta: "Working..." },
      { type: "text_end", contentIndex: 0 },
      done,
    ];
    const body = proxyEvents
      .map((event, index) => `data:${index === 1 ? " " : ""}${JSON.stringify(event)}\n`)
      .join("\n");
    const stream = startStream(responseFromText(body));
    const events = await collect(stream);

    expect(events.map((event) => event.type)).toEqual([
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    await expect(stream.result()).resolves.toMatchObject({
      content: [{ type: "text", text: "Working...", textSignature: "sig" }],
    });
  });

  it("delays tool argument previews while preserving exact terminal arguments", async () => {
    const initialContent = "a".repeat(128);
    const checkpointContent = "b".repeat(400);
    const deltas = [`{"content":"${initialContent}`, checkpointContent, `","terminal":"exact"}`];
    const stream = startStream(
      responseFromSseFrames([
        { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "write" },
        ...deltas.map((delta) => ({ type: "toolcall_delta", contentIndex: 0, delta })),
        { type: "toolcall_end", contentIndex: 0 },
        { type: "done", reason: "toolUse", usage },
      ]),
    );

    const argumentSnapshots: Array<Record<string, unknown>> = [];
    let terminalArguments: Record<string, unknown> | undefined;
    for await (const event of stream) {
      if (event.type === "toolcall_delta") {
        const content = event.partial.content[event.contentIndex];
        if (content?.type === "toolCall") {
          argumentSnapshots.push(structuredClone(content.arguments));
        }
      } else if (event.type === "toolcall_end") {
        terminalArguments = structuredClone(event.toolCall.arguments);
      }
    }

    const checkpointPreview = { content: initialContent + checkpointContent };
    expect(argumentSnapshots).toEqual([{}, checkpointPreview, checkpointPreview]);
    const exactArguments = { content: initialContent + checkpointContent, terminal: "exact" };
    expect(terminalArguments).toEqual(exactArguments);
    await expect(stream.result()).resolves.toMatchObject({
      content: [{ type: "toolCall", arguments: exactArguments }],
    });
  });

  it("preserves empty arguments for terminal-only tool calls", async () => {
    const stream = startStream(
      responseFromSseFrames([
        { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "list" },
        { type: "toolcall_end", contentIndex: 0 },
        { type: "done", reason: "toolUse", usage },
      ]),
    );

    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "call-1", name: "list", arguments: {} }],
    });
  });

  it("flushes a final SSE frame without a trailing newline", async () => {
    const fetchMock = stubResponse(responseFromText(`data: ${JSON.stringify(done)}`));

    const options = {
      ...proxyOptions,
      headers: { Authorization: "Bearer upstream", "x-api-key": "secret" },
    };
    const stream = streamProxy(model, context, options);
    const events = await collect(stream);

    expect(events.at(-1)?.type).toBe("done");
    await expect(stream.result()).resolves.toMatchObject({
      role: "assistant",
      stopReason: "stop",
      usage,
    });
    const body = requestBody(fetchMock);
    expect(body.options).not.toHaveProperty("headers");
    expect(body.options?.promptCacheKey).toBeUndefined();
    expect(body.model).not.toHaveProperty("headers");
  });

  it("forwards prompt cache affinity separately from session identity", async () => {
    const fetchMock = stubResponse(responseFromText(`data: ${JSON.stringify(done)}`));

    await streamProxy(model, context, {
      ...proxyOptions,
      sessionId: "run-session",
      promptCacheKey: "stable-cache-key",
      promptCacheTtl: "12h",
    }).result();

    const body = requestBody(fetchMock);
    expect(body.options).toMatchObject({
      sessionId: "run-session",
      promptCacheKey: "stable-cache-key",
      promptCacheTtl: "12h",
    });
  });

  it("applies timeoutMs before proxy response headers arrive", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(
              signal.reason instanceof Error ? signal.reason : new Error("Request was aborted"),
            );
          });
        });
      }),
    );

    const stream = streamProxy(model, context, { ...proxyOptions, timeoutMs: 5 });
    await vi.advanceTimersByTimeAsync(5);

    expect(await settledResult(stream)).toMatchObject({
      stopReason: "error",
      errorMessage: "Proxy request timed out after 5ms",
    });
  });

  it.each([
    { name: "JSON error", prefix: '{"error":"', delimiter: "", status: 502, kind: "error body" },
    { name: "pending SSE", prefix: "data: ", delimiter: "", status: 200, kind: "SSE stream" },
    { name: "delimited SSE", prefix: "data: ", delimiter: "\n", status: 200, kind: "SSE stream" },
  ])("bounds $name bytes", async ({ prefix, delimiter, status, kind }) => {
    const cancel = vi.fn(async (_reason?: unknown) => {});
    stubResponse(
      readerResponse([`${prefix}${"x".repeat(17 * 1024 * 1024)}${delimiter}`], {
        status,
        pending: true,
        cancel,
      }),
    );
    const stream = streamProxy(model, context, proxyOptions);
    expect(await resultWithinMs(stream)).toMatchObject({
      stopReason: "error",
      errorMessage: `Proxy ${kind} exceeded 16777216 bytes`,
    });
    expect(cancel).toHaveBeenCalled();
    if (status === 200) {
      expect(cancel).toHaveBeenCalledWith(expect.any(Error));
    }
  });

  it.each([
    { name: "re-arms the default idle timeout", intervalMs: 119_000, timeoutMs: undefined },
    { name: "does not impose an absolute stream deadline", intervalMs: 4, timeoutMs: 5 },
  ])("$name", async ({ intervalMs, timeoutMs }) => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const secondRead = Promise.withResolvers<ReadableStreamReadResult<Uint8Array>>();
    const thirdRead = Promise.withResolvers<ReadableStreamReadResult<Uint8Array>>();
    const cancel = vi.fn(async () => undefined);
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: encoder.encode("data: ") })
        .mockReturnValueOnce(secondRead.promise)
        .mockReturnValueOnce(thirdRead.promise),
      cancel,
      releaseLock: vi.fn(),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    stubResponse({ ok: true, body: { getReader: () => reader } } as Response);

    const stream = streamProxy(model, context, { ...proxyOptions, timeoutMs });

    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(cancel).not.toHaveBeenCalled();
    secondRead.resolve({
      done: false,
      value: encoder.encode(`${JSON.stringify({ type: "start" })}\n\n`),
    });
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(cancel).not.toHaveBeenCalled();
    thirdRead.resolve({
      done: false,
      value: encoder.encode(sseFrame(done)),
    });

    await expect(stream.result()).resolves.toMatchObject({ stopReason: "stop", usage });
  });

  it("honors a longer configured SSE read idle timeout", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(async (_reason?: unknown) => {});
    const stream = startStream(readerResponse([], { pending: true, cancel }), {
      timeoutMs: 180_000,
    });
    await vi.advanceTimersByTimeAsync(120_000);

    expect(await settledResult(stream)).toBe(unresolved);
    expect(cancel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(await settledResult(stream)).toMatchObject({
      stopReason: "error",
      errorMessage: "Proxy SSE stream stalled: no data received for 180000ms",
    });
    expect(cancel).toHaveBeenCalledWith(expect.any(Error));
  });

  it("releases the response reader when terminal stream cancellation never settles", async () => {
    const releaseLock = vi.fn();
    const stream = startStream(
      readerResponse([sseFrame(done)], { releaseLock, cancel: () => new Promise<void>(() => {}) }),
    );

    await stream.result();

    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("does not cancel a naturally drained response ending with a terminal frame", async () => {
    const cancel = vi.fn(async () => undefined);
    const stream = startStream(readerResponse([`data: ${JSON.stringify(done)}`], { cancel }));
    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "stop",
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("returns an error result when EOF arrives without a terminal event", async () => {
    const stream = startStream(responseFromText(`data: ${JSON.stringify({ type: "start" })}`));
    const events = await collect(stream);

    expect(events.at(-1)?.type).toBe("error");
    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: "Proxy stream ended before terminal event",
    });
  });
});

describe("streamProxy loopback /api/stream", () => {
  let server: http.Server | undefined;
  let dripInterval: ReturnType<typeof setInterval> | undefined;

  async function listen(listener: http.RequestListener, handleClientError = false) {
    server = http.createServer(listener);
    if (handleClientError) {
      server.on("clientError", (_err, socket) => socket.destroy());
    }
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    return address.port;
  }

  function loopbackOptions(port: number) {
    return { ...proxyOptions, proxyUrl: `http://127.0.0.1:${port}`, timeoutMs: 3_000 };
  }

  afterEach(async () => {
    clearInterval(dripInterval);
    if (!server) {
      return;
    }
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
    server = undefined;
  });

  async function listenProxyErrorBody(bytes: Buffer, splitAt: number) {
    let request: [string | undefined, string | undefined, string | undefined] | undefined;
    const port = await listen((req, res) => {
      request = [req.method, req.url, req.headers.authorization];
      if (req.method !== "POST" || req.url !== "/api/stream") {
        res.writeHead(404);
        res.end();
        return;
      }

      res.writeHead(502, "Bad Gateway", { "Content-Type": "application/json" });
      res.write(bytes.subarray(0, splitAt));
      res.end(bytes.subarray(splitAt));
    }, true);
    const result = await streamProxy(model, context, loopbackOptions(port)).result();
    expect(request).toEqual(["POST", "/api/stream", "Bearer token"]);
    return result;
  }

  it.each([
    {
      name: "terminal success",
      terminal: done,
      expected: { stopReason: "stop" },
    },
    {
      name: "terminal error",
      terminal: { type: "error", reason: "error", errorMessage: "upstream failed", usage },
      expected: { stopReason: "error", errorMessage: "upstream failed" },
    },
    {
      name: "malformed event",
      terminal: "{invalid json",
      expected: { stopReason: "error" },
    },
  ])(
    "closes a hanging native SSE body after $name without applying later frames",
    async (entry) => {
      const closed = Promise.withResolvers<void>();
      const port = await listen((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.once("close", () => closed.resolve());
        const frames = [
          { type: "text_start", contentIndex: 0 },
          { type: "text_delta", contentIndex: 0, delta: "visible" },
          entry.terminal,
          { type: "text_delta", contentIndex: 0, delta: " late mutation" },
        ];
        res.write(
          frames
            .map(
              (frame) => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`,
            )
            .join(""),
        );
      });
      const result = await streamProxy(model, context, loopbackOptions(port)).result();
      // Native cancellation closes the remote socket asynchronously; the test owns the deadline.
      await closed.promise;
      expect(result).toMatchObject({
        ...entry.expected,
        content: [{ type: "text", text: "visible" }],
      });
    },
  );

  it.each([
    { name: "rejects malformed UTF-8", character: Buffer.from([0xff]), error: "502 Bad Gateway" },
    {
      name: "preserves a valid replacement character",
      character: Buffer.from("\uFFFD"),
      error: "upstream \uFFFD",
    },
  ])("$name in proxy error responses", async ({ character, error }) => {
    const prefix = Buffer.from('{"error":"upstream ');
    const bytes = Buffer.concat([prefix, character, Buffer.from('"}')]);
    const result = await listenProxyErrorBody(bytes, prefix.length + 1);
    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: `Proxy error: ${error}`,
    });
  });

  it("cancels a dripping native SSE body when the outer abort signal fires", async () => {
    const port = await listen((req, res) => {
      res.on("error", () => {});
      if (req.method !== "POST" || req.url !== "/api/stream") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Transfer-Encoding": "chunked" });
      const drip = () => {
        if (!res.writableEnded && !res.destroyed) {
          res.write(sseFrame({ type: "start" }));
        }
      };
      dripInterval = setInterval(drip, 20);
      res.once("close", () => clearInterval(dripInterval));
      drip();
    }, true);
    const controller = new AbortController();
    const stream = streamProxy(model, context, {
      ...loopbackOptions(port),
      // Idle well above drip cadence so only the outer abort can terminate.
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    const firstEvent = await stream[Symbol.asyncIterator]().next();
    expect(firstEvent).toMatchObject({ done: false, value: { type: "start" } });
    controller.abort();

    expect(await resultWithinMs(stream, 1_500)).toMatchObject({
      stopReason: "aborted",
      errorMessage: "Request aborted by user",
    });
  });
});
