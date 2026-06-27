// Runtime proxy tests cover SSE parsing, terminal error handling, and request
// payload scrubbing before proxying model streams.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Model, Usage } from "../../llm/types.js";
import { streamProxy } from "./proxy.js";

const usage: Usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model: Model = {
  id: "test-model",
  name: "Test Model",
  provider: "test",
  api: "openai-responses",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1024,
  maxTokens: 1024,
};

const context: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function responseFromText(text: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

function responseFromReaderText(text: string, releaseLock: () => void): Response {
  const chunks: Array<ReadableStreamReadResult<Uint8Array>> = [
    { done: false, value: new TextEncoder().encode(text) },
    { done: true, value: undefined },
  ];
  const reader = {
    read: async () => chunks.shift() ?? { done: true, value: undefined },
    cancel: async () => undefined,
    releaseLock,
  } as ReadableStreamDefaultReader<Uint8Array>;

  return {
    ok: true,
    status: 200,
    body: { getReader: () => reader },
  } as Response;
}

describe("streamProxy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("flushes a final SSE frame without a trailing newline", async () => {
    // Provider proxies can close immediately after the last SSE frame; the
    // parser still has to emit the terminal done event.
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      responseFromText(
        `data: ${JSON.stringify({
          type: "done",
          reason: "stop",
          usage,
        })}`,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const options = {
      authToken: "token",
      headers: { Authorization: "Bearer upstream", "x-api-key": "secret" },
      proxyUrl: "https://proxy.example",
    };
    const stream = streamProxy(model, context, options);
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe("done");
    await expect(stream.result()).resolves.toMatchObject({
      role: "assistant",
      stopReason: "stop",
      usage,
    });
    const rawBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(typeof rawBody).toBe("string");
    const body = JSON.parse(rawBody as string) as {
      model?: { headers?: unknown };
      options?: { headers?: unknown; promptCacheKey?: string };
    };
    expect(body.options).not.toHaveProperty("headers");
    expect(body.options?.promptCacheKey).toBeUndefined();
    expect(body.model).not.toHaveProperty("headers");
  });

  it("forwards prompt cache affinity separately from session identity", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      responseFromText(
        `data: ${JSON.stringify({
          type: "done",
          reason: "stop",
          usage,
        })}`,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
      sessionId: "run-session",
      promptCacheKey: "stable-cache-key",
    }).result();

    const rawBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(typeof rawBody).toBe("string");
    const body = JSON.parse(rawBody as string) as {
      options?: { promptCacheKey?: string; sessionId?: string };
    };
    expect(body.options).toMatchObject({
      sessionId: "run-session",
      promptCacheKey: "stable-cache-key",
    });
  });

  it("releases the proxy response reader after a terminal stream", async () => {
    let resolveReleased: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    const releaseLock = vi.fn(() => {
      resolveReleased?.();
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        responseFromReaderText(
          `data: ${JSON.stringify({
            type: "done",
            reason: "stop",
            usage,
          })}\n\n`,
          releaseLock,
        ),
      ),
    );

    await streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
    }).result();
    await released;

    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("returns an error result when EOF arrives without a terminal event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseFromText(`data: ${JSON.stringify({ type: "start" })}`)),
    );

    const stream = streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
    });
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe("error");
    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: "Proxy stream ended before terminal event",
    });
  });

  it("rejects an oversized complete SSE line (> 1 MiB) in a single chunk", async () => {
    const largeLine = "data: " + "x".repeat(1024 * 1024 + 1) + "\n\n";
    const doneLine = `data: ${JSON.stringify({ type: "done", reason: "stop", usage })}\n\n`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseFromText(largeLine + doneLine)),
    );

    const stream = streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
    });
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe("error");
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/exceeds maximum allowed size/i);
  });

  it("rejects an oversized line deterministically regardless of TCP chunking", async () => {
    // Same line split across TWO chunks — must behave identically
    const largeLine = "data: " + "x".repeat(1024 * 1024 + 1) + "\n";
    const doneLine = `data: ${JSON.stringify({ type: "done", reason: "stop", usage })}\n\n`;
    const chunk1 = largeLine.slice(0, 500 * 1024);
    const chunk2 = largeLine.slice(500 * 1024);
    const responseText = chunk1 + chunk2 + doneLine;

    const responseFromTwoChunks = (text: string): Response => {
      const encoder = new TextEncoder();
      const chunks = text.match(/[\s\S]{1,524288}/g) ?? [];
      return new Response(
        new ReadableStream({
          async pull(controller) {
            for (const chunk of chunks) {
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
          },
        }),
        { status: 200 },
      );
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseFromTwoChunks(responseText)),
    );

    const stream = streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
    });
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe("error");
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/exceeds maximum allowed size/i);
  });

  it("allows many small coalesced lines in a single chunk without false positive", async () => {
    // 2000 small lines + terminal event in one chunk
    const smallLines: string[] = [];
    for (let i = 0; i < 2000; i++) {
      smallLines.push(`data: ${JSON.stringify({ type: "pending", index: i })}\n`);
    }
    smallLines.push(`data: ${JSON.stringify({ type: "done", reason: "stop", usage })}\n\n`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseFromText(smallLines.join(""))),
    );

    const stream = streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
    });
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe("done");
    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "stop",
      usage,
    });
  });

  it("rejects an oversized unterminated buffer without newline across multiple chunks", async () => {
    // First chunk has \n, leaving a 600 KiB unterminated tail in buffer.
    // Second chunk appends 600 KiB more without \n. The tail cap fires when
    // the accumulated unterminated tail exceeds 1 MiB.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const encoder = new TextEncoder();
        const chunkIndex = { current: 0 };
        return new Response(
          new ReadableStream({
            async pull(controller) {
              if (chunkIndex.current === 0) {
                // "hello\n" + 600 KiB — has \n, leaves 600 KiB tail
                controller.enqueue(encoder.encode("hello\n" + "x".repeat(600 * 1024)));
              } else if (chunkIndex.current === 1) {
                // 600 KiB more without \n → buffer = 1.2 MiB → tail cap fires
                controller.enqueue(encoder.encode("y".repeat(600 * 1024)));
              } else {
                controller.close();
              }
              chunkIndex.current++;
            },
          }),
          { status: 200 },
        );
      }),
    );

    const stream = streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
    });
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe("error");
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/exceeds maximum allowed size/i);
  });

  it("rejects an oversized final frame at EOF without trailing newline", async () => {
    // Server closes connection after a 1.2 MiB data: line without any \n.
    // The line is split into lines[0] (the entire data), which triggers the
    // byte-accurate line cap — proving all buffered data is bounded.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response("data: " + "x".repeat(1200 * 1024));
      }),
    );

    const stream = streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
    });
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe("error");
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/exceeds maximum allowed size/i);
  });
});
