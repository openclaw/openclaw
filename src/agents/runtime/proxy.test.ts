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

  it("bounds streamed proxy success bodies without content-length", async () => {
    // 1 MiB chunks; cap is 16 MiB so the bounded reader cancels well before
    // draining the full 32 MiB advertised body.
    const CHUNK = 1024 * 1024;
    const TOTAL = 32;
    let pullCount = 0;
    let cancelReason: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                pullCount += 1;
                if (pullCount > TOTAL) {
                  controller.close();
                  return;
                }
                controller.enqueue(new Uint8Array(CHUNK));
              },
              cancel(reason) {
                cancelReason = reason;
              },
            }),
            { status: 200 },
          ),
      ),
    );

    const result = await streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/Proxy stream body exceeded \d+ bytes/);
    expect(cancelReason).toBeInstanceOf(Error);
    // 16 MiB + a couple of overshoot pulls, well under 32.
    expect(pullCount).toBeGreaterThanOrEqual(17);
    expect(pullCount).toBeLessThanOrEqual(20);
  });
});
