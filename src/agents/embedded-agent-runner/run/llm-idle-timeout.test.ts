import { notifyLlmRequestActivity } from "@openclaw/ai/internal/runtime";
import { expectDefined } from "@openclaw/normalization-core";
import { toErrorObject as toLintErrorObject } from "@openclaw/normalization-core/error-coercion";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
} from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearToolActivityRun,
  notifyToolActivity,
} from "../../../shared/tool-activity-heartbeat.js";
import type { StreamFn } from "../../runtime/index.js";
import { streamWithIdleTimeout } from "./llm-idle-timeout.js";

describe("streamWithIdleTimeout", () => {
  const TEST_RUN = "test-run";

  afterEach(() => {
    clearToolActivityRun(TEST_RUN);
    vi.useRealTimers();
  });

  function createMockAsyncIterable<T>(chunks: T[]): AsyncIterable<T> {
    // Keep the stream fixture deterministic so timer tests only cover wrapper
    // behavior, not async generator scheduling.
    return {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            if (index < chunks.length) {
              return {
                done: false,
                value: expectDefined(chunks[index++], "chunks[index++] test invariant"),
              };
            }
            return { done: true, value: undefined };
          },
          async return() {
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  function createNeverYieldingStream(): AsyncIterable<unknown> {
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return new Promise<IteratorResult<unknown>>(() => {});
          },
        };
      },
    };
  }

  it("passes through model, context, and options", () => {
    const mockStream = createMockAsyncIterable([]);
    const baseFn = vi.fn().mockReturnValue(mockStream);
    const wrapped = streamWithIdleTimeout(baseFn, 1000);

    const model = { api: "openai", requestTimeoutMs: 5000 } as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    void wrapped(model, context, options);

    expect(baseFn).toHaveBeenCalledWith(model, context, {
      signal: expect.any(AbortSignal),
    });
  });

  it("preserves explicit model request timeouts", () => {
    const mockStream = createMockAsyncIterable([]);
    const baseFn = vi.fn().mockReturnValue(mockStream);
    const wrapped = streamWithIdleTimeout(baseFn, 1000);

    const model = { requestTimeoutMs: 250 } as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    void wrapped(model, context, options);

    expect(baseFn).toHaveBeenCalledWith(model, context, {
      signal: expect.any(AbortSignal),
    });
  });

  it("throws on idle timeout", async () => {
    vi.useFakeTimers();
    const slowStream = createNeverYieldingStream();
    const baseFn = vi.fn().mockReturnValue(slowStream);
    const wrapped = streamWithIdleTimeout(baseFn, 50); // 50ms timeout

    const model = {} as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    const stream = wrapped(model, context, options) as AsyncIterable<unknown>;
    const iterator = stream[Symbol.asyncIterator]();

    const next = expect(iterator.next()).rejects.toThrow(/LLM idle timeout/);
    await vi.advanceTimersByTimeAsync(50);
    await next;
  });

  it("creation-only scope bounds stream creation but not iterator gaps", async () => {
    vi.useFakeTimers();
    // Creation hang: still rejected at the deadline.
    const hangingCreate = vi.fn(
      () => new Promise<AssistantMessageEventStream>(() => {}),
    ) as unknown as Parameters<typeof streamWithIdleTimeout>[0];
    const onIdleTimeout = vi.fn();
    const wrappedCreate = streamWithIdleTimeout(hangingCreate, 50, onIdleTimeout, {
      scope: "creation-only",
    });
    const model = {} as Parameters<typeof hangingCreate>[0];
    const context = {} as Parameters<typeof hangingCreate>[1];
    const options = {} as Parameters<typeof hangingCreate>[2];
    const pending = expect(wrappedCreate(model, context, options)).rejects.toThrow(
      /LLM idle timeout/,
    );
    await vi.advanceTimersByTimeAsync(50);
    await pending;
    expect(onIdleTimeout).toHaveBeenCalledTimes(1);

    // Iterator gap: never bounded — local providers own their stream pacing.
    const slowStream = createNeverYieldingStream();
    const slowFn = vi.fn().mockReturnValue(slowStream);
    const wrappedGaps = streamWithIdleTimeout(slowFn, 50, onIdleTimeout, {
      scope: "creation-only",
    });
    const stream = wrappedGaps(
      model as Parameters<typeof slowFn>[0],
      context as Parameters<typeof slowFn>[1],
      options as Parameters<typeof slowFn>[2],
    ) as AsyncIterable<unknown>;
    const iterator = stream[Symbol.asyncIterator]();
    let settled = false;
    void iterator.next().finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);
    expect(onIdleTimeout).toHaveBeenCalledTimes(1);
  });

  it("clears the connection timer when stream setup rejects", async () => {
    vi.useFakeTimers();
    const setupError = new Error("provider setup failed");
    const baseFn = vi.fn().mockRejectedValue(setupError);

    const onIdleTimeout = vi.fn();
    const wrapped = streamWithIdleTimeout(baseFn, 50, onIdleTimeout);

    const model = {} as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    await expect(wrapped(model, context, options)).rejects.toThrow("provider setup failed");
    await vi.advanceTimersByTimeAsync(50);

    expect(onIdleTimeout).not.toHaveBeenCalled();
  });

  it("throws when a promise stream never resolves", async () => {
    vi.useFakeTimers();
    let streamSignal: AbortSignal | undefined;
    const baseFn = vi.fn((_model, _context, options) => {
      streamSignal = options?.signal;
      // Simulate providers that hang during stream creation but honor abort
      // once the idle watchdog fires.
      return new Promise<AssistantMessageEventStream>((_resolve, reject) => {
        streamSignal?.addEventListener("abort", () => {
          reject(toLintErrorObject(streamSignal?.reason, "Non-Error rejection"));
        });
      });
    });
    const onIdleTimeout = vi.fn();
    const wrapped = streamWithIdleTimeout(baseFn, 50, onIdleTimeout);

    const model = {} as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    const stream = expect(wrapped(model, context, options)).rejects.toThrow(/LLM idle timeout/);
    await vi.advanceTimersByTimeAsync(50);
    await stream;

    expect(onIdleTimeout).toHaveBeenCalledTimes(1);
    expect(streamSignal?.aborted).toBe(true);
  });

  it("clears setup state when baseFn throws synchronously", async () => {
    vi.useFakeTimers();
    const setupError = new Error("sync provider setup failed");
    const baseFn = vi.fn(() => {
      throw setupError;
    }) as unknown as Parameters<typeof streamWithIdleTimeout>[0];
    const onIdleTimeout = vi.fn();
    const wrapped = streamWithIdleTimeout(baseFn, 50, onIdleTimeout);

    const model = {} as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    expect(() => wrapped(model, context, options)).toThrow("sync provider setup failed");
    await vi.advanceTimersByTimeAsync(500);

    expect(onIdleTimeout).not.toHaveBeenCalled();
  });

  it("resets timer on each chunk", async () => {
    const chunks = [{ text: "a" }, { text: "b" }, { text: "c" }];
    const mockStream = createMockAsyncIterable(chunks);
    const baseFn = vi.fn().mockReturnValue(mockStream);
    const wrapped = streamWithIdleTimeout(baseFn, 1000);

    const model = {} as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    const stream = wrapped(model, context, options) as AsyncIterable<unknown>;
    const results: unknown[] = [];

    for await (const chunk of stream) {
      results.push(chunk);
    }

    expect(results).toEqual(chunks);
  });

  it("handles stream with delays between chunks", async () => {
    vi.useFakeTimers();
    // Create a stream with small delays
    const delayedStream: AsyncIterable<{ text: string }> = {
      [Symbol.asyncIterator]() {
        let count = 0;
        return {
          async next() {
            if (count < 3) {
              await new Promise((r) => {
                setTimeout(r, 10);
              }); // 10ms delay
              return { done: false, value: { text: String(count++) } };
            }
            return { done: true, value: undefined };
          },
        };
      },
    };

    const baseFn = vi.fn().mockReturnValue(delayedStream);
    const wrapped = streamWithIdleTimeout(baseFn, 100); // 100ms timeout - should be enough

    const model = {} as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    const stream = wrapped(model, context, options) as AsyncIterable<{ text: string }>;
    const results: { text: string }[] = [];

    const collect = (async () => {
      for await (const chunk of stream) {
        results.push(chunk);
      }
    })();

    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(10);
    }
    await collect;

    expect(results).toHaveLength(3);
  });

  it("treats quarantined provider events as stream activity", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const baseFn: StreamFn = vi.fn((_model, _context, options) => {
      requestSignal = options?.signal;
      const stream = createAssistantMessageEventStream();
      setTimeout(() => {
        stream.push({ type: "text_delta", contentIndex: 0, delta: "done" });
      }, 120);
      return stream;
    });
    const wrapped = streamWithIdleTimeout(baseFn, 50);
    const stream = wrapped(
      {} as Parameters<typeof baseFn>[0],
      {} as Parameters<typeof baseFn>[1],
      {} as Parameters<typeof baseFn>[2],
    ) as AssistantMessageEventStream;
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();

    setTimeout(() => notifyLlmRequestActivity(requestSignal), 40);
    setTimeout(() => notifyLlmRequestActivity(requestSignal), 80);
    await vi.advanceTimersByTimeAsync(120);

    await expect(next).resolves.toEqual({
      done: false,
      value: { type: "text_delta", contentIndex: 0, delta: "done" },
    });
    await iterator.return?.();
  });

  it("resets idle timer on tool activity", async () => {
    vi.useFakeTimers();
    const baseFn: StreamFn = vi.fn((_model, _context, _options) => {
      const stream = createAssistantMessageEventStream();
      setTimeout(() => {
        stream.push({ type: "text_delta", contentIndex: 0, delta: "done" });
      }, 120);
      return stream;
    });
    const wrapped = streamWithIdleTimeout(baseFn, 50, undefined, { runId: TEST_RUN });
    const stream = wrapped(
      {} as Parameters<typeof baseFn>[0],
      {} as Parameters<typeof baseFn>[1],
      {} as Parameters<typeof baseFn>[2],
    ) as AssistantMessageEventStream;
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();

    setTimeout(() => notifyToolActivity(TEST_RUN), 40);
    setTimeout(() => notifyToolActivity(TEST_RUN), 80);
    await vi.advanceTimersByTimeAsync(120);

    await expect(next).resolves.toEqual({
      done: false,
      value: { type: "text_delta", contentIndex: 0, delta: "done" },
    });
    await iterator.return?.();
  });

  it("accounts for tool activity that happened before stream creation in idle timeout", async () => {
    vi.useFakeTimers();
    const baseFn: StreamFn = vi.fn((_model, _context, _options) => {
      const stream = createAssistantMessageEventStream();
      setTimeout(() => {
        stream.push({ type: "text_delta", contentIndex: 0, delta: "done" });
      }, 140);
      return stream;
    });
    const wrapped = streamWithIdleTimeout(baseFn, 100, undefined, { runId: TEST_RUN });

    // Simulate tool activity 40ms before the stream starts. The first arm will
    // compute effective = max(1, 100 - 40) = 60, timer at t=100 (40 + 60).
    // Another tool reset at t=70 extends it to t=170. Data at t=180
    // (40 + 140) needs one more reset.
    vi.advanceTimersByTime(40);
    notifyToolActivity(TEST_RUN);

    const stream = wrapped(
      {} as Parameters<typeof baseFn>[0],
      {} as Parameters<typeof baseFn>[1],
      {} as Parameters<typeof baseFn>[2],
    ) as AssistantMessageEventStream;
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();

    setTimeout(() => notifyToolActivity(TEST_RUN), 70);
    setTimeout(() => notifyToolActivity(TEST_RUN), 130);
    await vi.advanceTimersByTimeAsync(180);

    await expect(next).resolves.toEqual({
      done: false,
      value: { type: "text_delta", contentIndex: 0, delta: "done" },
    });
    await iterator.return?.();
  });

  it("gives full idle budget to subsequent chunks after consuming the pre-stream tool timestamp", async () => {
    // Regression: a stale pre-stream tool timestamp was reused for every
    // per-chunk wait, shrinking the effective timeout on each iteration and
    // eventually aborting a legitimately slow active stream. The fix makes the
    // pre-stream timestamp single-use: consumed on the first bridged wait, then
    // cleared so subsequent chunk progress restores a full idle budget.
    vi.useFakeTimers();
    const timeoutMs = 50;
    const baseFn: StreamFn = vi.fn((_model, _context, _options) => {
      const stream = createAssistantMessageEventStream();
      // Chunk 1 at T=30 (10ms after stream creation at T=20).
      setTimeout(() => {
        stream.push({ type: "text_delta", contentIndex: 0, delta: "first" });
      }, 10);
      // Chunk 2 at T=75 (45ms after chunk 1). With the carry-over bug the
      // second arm would compute effective = max(1, 50-(75-0)) = ... but at
      // arm time (T=30) it is max(1, 50-(30-0)) = 20ms, timeout at T=50,
      // well before chunk 2 arrives. With the fix the second arm gets the
      // full 50ms, timer at T=80, and chunk 2 at T=75 survives.
      setTimeout(() => {
        stream.push({ type: "text_delta", contentIndex: 0, delta: "second" });
      }, 55);
      return stream;
    });
    const wrapped = streamWithIdleTimeout(baseFn, timeoutMs, undefined, { runId: TEST_RUN });

    // Pre-stream tool activity at T=0, then 20ms elapses before stream creation.
    notifyToolActivity(TEST_RUN);
    vi.advanceTimersByTime(20);

    const stream = wrapped(
      {} as Parameters<typeof baseFn>[0],
      {} as Parameters<typeof baseFn>[1],
      {} as Parameters<typeof baseFn>[2],
    ) as AssistantMessageEventStream;
    const iterator = stream[Symbol.asyncIterator]();

    // First chunk: bridged wait benefits from pre-stream tool timestamp.
    const first = iterator.next();
    await vi.advanceTimersByTimeAsync(10);
    await expect(first).resolves.toEqual({
      done: false,
      value: { type: "text_delta", contentIndex: 0, delta: "first" },
    });

    // Second chunk: 45ms after the first. Must get a full 50ms idle budget
    // (not the ~20ms that the carry-over bug would compute).
    const second = iterator.next();
    await vi.advanceTimersByTimeAsync(45);
    await expect(second).resolves.toEqual({
      done: false,
      value: { type: "text_delta", contentIndex: 0, delta: "second" },
    });

    await iterator.return?.();
  });

  it("preserves full idle budget for mid-stream LLM activity resets after pre-stream tool consumption", async () => {
    // After the pre-stream tool timestamp is consumed, mid-stream
    // onLlmRequestActivity resets should still arm a full-idle timer.
    vi.useFakeTimers();
    const timeoutMs = 50;
    let requestSignal: AbortSignal | undefined;
    const baseFn: StreamFn = vi.fn((_model, _context, options) => {
      requestSignal = options?.signal;
      const stream = createAssistantMessageEventStream();
      // Chunk arrives at T=100 (80ms after stream creation at T=20).
      setTimeout(() => {
        stream.push({ type: "text_delta", contentIndex: 0, delta: "late" });
      }, 80);
      return stream;
    });
    const wrapped = streamWithIdleTimeout(baseFn, timeoutMs, undefined, { runId: TEST_RUN });

    // Pre-stream tool activity at T=0, then 20ms elapses before stream creation.
    notifyToolActivity(TEST_RUN);
    vi.advanceTimersByTime(20);

    const stream = wrapped(
      {} as Parameters<typeof baseFn>[0],
      {} as Parameters<typeof baseFn>[1],
      {} as Parameters<typeof baseFn>[2],
    ) as AssistantMessageEventStream;
    const iterator = stream[Symbol.asyncIterator]();

    const next = iterator.next();

    // Mid-stream LLM activity resets at T=40 and T=60 keep the watchdog alive.
    // The first arm used the pre-stream timestamp (effective ~30ms, timer at
    // ~T=50). Without these resets the timer would fire before the chunk arrives
    // at T=100. With them each reset arms a full 50ms budget.
    setTimeout(() => notifyLlmRequestActivity(requestSignal), 20);
    setTimeout(() => notifyLlmRequestActivity(requestSignal), 40);
    await vi.advanceTimersByTimeAsync(80);

    await expect(next).resolves.toEqual({
      done: false,
      value: { type: "text_delta", contentIndex: 0, delta: "late" },
    });
    await iterator.return?.();
  });

  it("calls timeout hook on idle timeout", async () => {
    vi.useFakeTimers();
    const slowStream = createNeverYieldingStream();
    const baseFn = vi.fn().mockReturnValue(slowStream);
    const onIdleTimeout = vi.fn();
    const wrapped = streamWithIdleTimeout(baseFn, 50, onIdleTimeout); // 50ms timeout

    const model = {} as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    const stream = wrapped(model, context, options) as AsyncIterable<unknown>;
    const iterator = stream[Symbol.asyncIterator]();

    const next = iterator.next().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    const error = await next;

    // Verify the error message is preserved
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/LLM idle timeout/);
    expect(onIdleTimeout).toHaveBeenCalledTimes(1);
    const [timeoutError] = onIdleTimeout.mock.calls.at(0) ?? [];
    expect(timeoutError).toBeInstanceOf(Error);
    expect((timeoutError as Error).message).toMatch(/LLM idle timeout/);
  });
});
