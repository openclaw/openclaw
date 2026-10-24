import { once } from "node:events";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Model, Usage } from "../../llm/types.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { streamProxy } from "./proxy.js";

const usage: Usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model: Model = makeProviderModelFixture({
  id: "test-model",
  name: "Test Model",
  provider: "test",
  api: "openai-responses",
  baseUrl: "https://example.test",
  contextWindow: 1024,
  maxTokens: 1024,
});

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

const proxyOptions = { authToken: "token", proxyUrl: "https://proxy.example" };
const done = { type: "done", reason: "stop", usage };

function stubResponse(response: Response) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
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

async function collectEvents(stream: ReturnType<typeof streamProxy>) {
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function readerResponse(reader: ReadableStreamDefaultReader<Uint8Array>): Response {
  return { ok: true, status: 200, body: { getReader: () => reader } } as Response;
}

function responseFromText(text: string): Response {
  return new Response(new TextEncoder().encode(text), { status: 200 });
}

function responseFromSseFrames(frames: unknown[]): Response {
  const encoder = new TextEncoder();
  const chunks = frames.map((frame) => encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
  const reader = {
    read: vi.fn(async () => {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const value = chunks.shift();
      return value ? { done: false, value } : { done: true, value: undefined };
    }),
    cancel: vi.fn(async () => undefined),
    releaseLock: vi.fn(),
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;

  return readerResponse(reader);
}

function responseFromReaderText(
  text: string,
  releaseLock: () => void,
  cancel: () => Promise<void> = async () => undefined,
): Response {
  const chunks: Array<ReadableStreamReadResult<Uint8Array>> = [
    { done: false, value: new TextEncoder().encode(text) },
    { done: true, value: undefined },
  ];
  const reader = {
    read: async () => chunks.shift() ?? { done: true, value: undefined },
    cancel,
    releaseLock,
  } as ReadableStreamDefaultReader<Uint8Array>;

  return readerResponse(reader);
}

const unresolved = Symbol("unresolved stream result");

function pendingReaderResponse(params: {
  chunks: Uint8Array[];
  status?: number;
  statusText?: string;
  onCancel?: (reason?: unknown) => void;
}): Response {
  const chunks = [...params.chunks];
  const reader = {
    read: vi.fn(async () => {
      const chunk = chunks.shift();
      if (chunk) {
        return { done: false, value: chunk };
      }
      return await new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
    }),
    cancel: vi.fn(async (reason?: unknown) => {
      params.onCancel?.(reason);
    }),
    releaseLock: vi.fn(),
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;

  return {
    ok: (params.status ?? 200) >= 200 && (params.status ?? 200) < 300,
    status: params.status ?? 200,
    statusText: params.statusText ?? "OK",
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
    // The SSE spec makes the space optional; proxies emitting `data:{...}`
    // must not have their events silently dropped.
    const proxyEvents = [
      { type: "text_start", contentIndex: 0, contentSignature: "sig" },
      { type: "text_delta", contentIndex: 0, delta: "Working..." },
      { type: "text_end", contentIndex: 0 },
      { type: "done", reason: "stop", usage },
    ];
    const body = proxyEvents
      .map((event, index) => `data:${index === 1 ? " " : ""}${JSON.stringify(event)}\n`)
      .join("\n");
    stubResponse(responseFromText(body));

    const stream = streamProxy(model, context, proxyOptions);
    const events = await collectEvents(stream);

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
    stubResponse(
      responseFromSseFrames([
        { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "write" },
        ...deltas.map((delta) => ({ type: "toolcall_delta", contentIndex: 0, delta })),
        { type: "toolcall_end", contentIndex: 0 },
        { type: "done", reason: "toolUse", usage },
      ]),
    );

    const stream = streamProxy(model, context, proxyOptions);
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
    stubResponse(
      responseFromSseFrames([
        { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "list" },
        { type: "toolcall_end", contentIndex: 0 },
        { type: "done", reason: "toolUse", usage },
      ]),
    );

    const stream = streamProxy(model, context, proxyOptions);

    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "call-1", name: "list", arguments: {} }],
    });
  });

  it("flushes a final SSE frame without a trailing newline", async () => {
    // Provider proxies can close immediately after the last SSE frame; the
    // parser still has to emit the terminal done event.
    const fetchMock = stubResponse(responseFromText(`data: ${JSON.stringify(done)}`));

    const options = {
      ...proxyOptions,
      headers: { Authorization: "Bearer upstream", "x-api-key": "secret" },
    };
    const stream = streamProxy(model, context, options);
    const events = await collectEvents(stream);

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

  async function expectBodySizeLimit(
    text: string,
    errorMessage: string,
    responseOptions: { status?: number; statusText?: string } = {},
  ) {
    const cancel = vi.fn();
    stubResponse(
      pendingReaderResponse({
        ...responseOptions,
        chunks: [new TextEncoder().encode(text)],
        onCancel: cancel,
      }),
    );
    const stream = streamProxy(model, context, proxyOptions);
    expect(await resultWithinMs(stream)).toMatchObject({ stopReason: "error", errorMessage });
    return cancel;
  }

  it("bounds non-2xx proxy JSON error reads", async () => {
    const cancel = await expectBodySizeLimit(
      `{"error":"${"x".repeat(17 * 1024 * 1024)}`,
      "Proxy error body exceeded 16777216 bytes",
      { status: 502, statusText: "Bad Gateway" },
    );
    expect(cancel).toHaveBeenCalled();
  });

  async function expectSseSizeLimit(delimiter: string) {
    const cancel = await expectBodySizeLimit(
      `data: ${"x".repeat(17 * 1024 * 1024)}${delimiter}`,
      "Proxy SSE stream exceeded 16777216 bytes",
    );
    expect(cancel).toHaveBeenCalledWith(expect.any(Error));
  }

  it("caps unterminated pending SSE bytes before a frame delimiter arrives", async () => {
    await expectSseSizeLimit("");
  });

  it("caps delimiter-terminated SSE success body bytes", async () => {
    await expectSseSizeLimit("\n");
  });

  async function expectStreamSurvivesChunks(intervalMs: number, timeoutMs?: number) {
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
    stubResponse(readerResponse(reader));

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
  }

  it("re-arms the SSE idle timeout after each received chunk", async () => {
    await expectStreamSurvivesChunks(119_000);
  });

  it("does not apply the pre-header timeout as an absolute stream deadline", async () => {
    await expectStreamSurvivesChunks(4, 5);
  });

  it("honors a longer configured SSE read idle timeout", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => undefined);
    stubResponse(pendingReaderResponse({ chunks: [], onCancel: cancel }));

    const stream = streamProxy(model, context, { ...proxyOptions, timeoutMs: 180_000 });
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
    stubResponse(
      responseFromReaderText(sseFrame(done), releaseLock, () => new Promise<void>(() => {})),
    );

    await streamProxy(model, context, proxyOptions).result();

    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("does not cancel a naturally drained response ending with a terminal frame", async () => {
    const cancel = vi.fn(async () => undefined);
    stubResponse(responseFromReaderText(`data: ${JSON.stringify(done)}`, () => undefined, cancel));

    await expect(streamProxy(model, context, proxyOptions).result()).resolves.toMatchObject({
      stopReason: "stop",
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("returns an error result when EOF arrives without a terminal event", async () => {
    stubResponse(responseFromText(`data: ${JSON.stringify({ type: "start" })}`));

    const stream = streamProxy(model, context, proxyOptions);
    const events = await collectEvents(stream);

    expect(events.at(-1)?.type).toBe("error");
    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: "Proxy stream ended before terminal event",
    });
  });
});

describe("streamProxy loopback /api/stream", () => {
  let server: http.Server | undefined;
  const dripIntervals = new Set<ReturnType<typeof setInterval>>();

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
    for (const interval of dripIntervals) {
      clearInterval(interval);
    }
    dripIntervals.clear();
    if (!server) {
      return;
    }
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
    server = undefined;
  });

  async function listenDripProxy(): Promise<number> {
    return await listen((req, res) => {
      res.on("error", () => {});
      if (req.method !== "POST" || req.url !== "/api/stream") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Transfer-Encoding": "chunked",
      });
      // Keepalive-style drip resets chunk-idle; outer abort must win.
      const drip = () => {
        if (res.writableEnded || res.destroyed) {
          return;
        }
        res.write(`data: ${JSON.stringify({ type: "start" })}\n\n`);
      };
      const interval = setInterval(drip, 20);
      dripIntervals.add(interval);
      res.once("close", () => {
        clearInterval(interval);
        dripIntervals.delete(interval);
      });
      drip();
    }, true);
  }

  async function listenProxyErrorBody(bytes: Buffer, splitAt: number) {
    const request: {
      method?: string;
      path?: string;
      authorization?: string;
    } = {};

    const port = await listen((req, res) => {
      request.method = req.method;
      request.path = req.url;
      request.authorization = req.headers.authorization;
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
    expect(request).toEqual({
      method: "POST",
      path: "/api/stream",
      authorization: "Bearer token",
    });
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

  it("falls back to the HTTP status for malformed UTF-8 proxy errors", async () => {
    const prefix = Buffer.from('{"error":"corrupted ');
    const bytes = Buffer.concat([prefix, Buffer.from([0xff]), Buffer.from(' upstream"}')]);
    const result = await listenProxyErrorBody(bytes, prefix.length);
    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "Proxy error: 502 Bad Gateway",
    });
  });

  it("preserves a valid replacement character in proxy error responses", async () => {
    const error = "upstream legitimately contains \uFFFD";
    const bytes = Buffer.from(JSON.stringify({ error }));
    const result = await listenProxyErrorBody(bytes, bytes.indexOf(0xef) + 1);
    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: `Proxy error: ${error}`,
    });
  });

  it("cancels a dripping native SSE body when the outer abort signal fires", async () => {
    const port = await listenDripProxy();
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
