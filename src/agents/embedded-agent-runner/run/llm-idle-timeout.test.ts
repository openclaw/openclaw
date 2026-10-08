import { notifyLlmRequestActivity } from "@openclaw/ai/internal/runtime";
import { toErrorObject as toLintErrorObject } from "@openclaw/normalization-core/error-coercion";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
} from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearToolActivityRun,
  notifyToolActivity,
} from "../../../shared/tool-activity-heartbeat.js";
import type { StreamFn } from "../../runtime/index.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import { wrapStreamFnRepairMalformedToolCallArguments } from "./attempt.tool-call-argument-repair.js";
import { streamWithIdleTimeout } from "./llm-idle-timeout.js";

describe("streamWithIdleTimeout", () => {
  const TEST_RUN = "test-run";

  afterEach(() => {
    clearToolActivityRun(TEST_RUN);
    vi.useRealTimers();
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

  it("gives full idle budget to subsequent chunks after consuming the pre-stream tool timestamp", async () => {
    // A stale pre-stream timestamp must not shorten later chunk budgets.
    vi.useFakeTimers();
    const timeoutMs = 50;
    const baseFn: StreamFn = vi.fn((_model, _context, _options) => {
      const stream = createAssistantMessageEventStream();
      // Chunk 1 at T=30 (10ms after stream creation at T=20).
      setTimeout(() => {
        stream.push({ type: "text_delta", contentIndex: 0, delta: "first" });
      }, 10);
      // The second chunk arrives after the stale timestamp would expire.
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

    // Each activity notification must restore a full 50ms budget.
    setTimeout(() => notifyLlmRequestActivity(requestSignal), 20);
    setTimeout(() => notifyLlmRequestActivity(requestSignal), 40);
    await vi.advanceTimersByTimeAsync(80);

    await expect(next).resolves.toEqual({
      done: false,
      value: { type: "text_delta", contentIndex: 0, delta: "late" },
    });
    await iterator.return?.();
  });
});

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

describe("streamWithIdleTimeout caller cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preempts a provider iterator that ignores abort", async () => {
    vi.useFakeTimers();
    const callerAbortController = new AbortController();
    const callerReason = new Error("caller cancelled");
    const baseFn = vi.fn().mockReturnValue(createNeverYieldingStream());
    const onIdleTimeout = vi.fn();
    const iterator = (
      streamWithIdleTimeout(baseFn, 50, onIdleTimeout)(
        {} as Parameters<typeof baseFn>[0],
        {} as Parameters<typeof baseFn>[1],
        { signal: callerAbortController.signal },
      ) as AsyncIterable<unknown>
    )[Symbol.asyncIterator]();
    const outcome = iterator.next().catch((error: unknown) => error);

    callerAbortController.abort(callerReason);

    await expect(outcome).resolves.toMatchObject({
      name: "AbortError",
      message: callerReason.message,
      cause: callerReason,
    });
    await vi.advanceTimersByTimeAsync(50);
    const providerSignal = (baseFn.mock.calls.at(0)?.[2] as { signal?: AbortSignal } | undefined)
      ?.signal;
    expect([providerSignal?.reason, onIdleTimeout.mock.calls.length]).toEqual([callerReason, 0]);
  });

  it.each([false, true])(
    "preempts provider stream creation (already aborted: %s)",
    async (alreadyAborted) => {
      vi.useFakeTimers();
      const callerAbortController = new AbortController();
      const callerReason = new Error("caller cancelled");
      if (alreadyAborted) {
        callerAbortController.abort(callerReason);
      }
      const baseFnMock = vi.fn(
        (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) =>
          options?.signal?.aborted
            ? Promise.reject(new Error("provider rejected cancelled setup"))
            : new Promise<AssistantMessageEventStream>(() => {}),
      );
      const baseFn = baseFnMock as unknown as Parameters<typeof streamWithIdleTimeout>[0];
      const onIdleTimeout = vi.fn();
      const pending = streamWithIdleTimeout(baseFn, 50, onIdleTimeout)(
        {} as Parameters<typeof baseFn>[0],
        {} as Parameters<typeof baseFn>[1],
        { signal: callerAbortController.signal },
      );

      callerAbortController.abort(callerReason);

      await expect(pending).rejects.toMatchObject({
        name: "AbortError",
        message: callerReason.message,
        cause: callerReason,
      });
      await vi.advanceTimersByTimeAsync(50);
      const providerSignal = (
        baseFnMock.mock.calls.at(0)?.[2] as { signal?: AbortSignal } | undefined
      )?.signal;
      expect([providerSignal?.reason, onIdleTimeout.mock.calls.length]).toEqual([callerReason, 0]);
    },
  );
});

describe("streamWithIdleTimeout parked consumer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves argument fragments when the producer completes while the consumer is parked", async () => {
    vi.useFakeTimers();
    const source = createAssistantMessageEventStream();
    const message: AssistantMessage = makeAgentAssistantMessage({
      content: [{ type: "toolCall", id: "call_read", name: "read", arguments: {} }],
      api: "openai-chatgpt-responses",
      model: "test",
      usage: createZeroUsageFixture(),
      stopReason: "toolUse",
      timestamp: 1,
    });
    let requestSignal: AbortSignal | undefined;
    const baseFn: StreamFn = (_model, _context, options) => {
      requestSignal = options?.signal;
      return source;
    };
    const onIdleTimeout = vi.fn();
    // Match attempt-stream's production order: repair inside the watchdog.
    const wrapped = streamWithIdleTimeout(
      wrapStreamFnRepairMalformedToolCallArguments(baseFn),
      50,
      onIdleTimeout,
    );
    const stream = await wrapped({} as Parameters<StreamFn>[0], {} as Parameters<StreamFn>[1], {});
    const iterator = stream[Symbol.asyncIterator]();
    source.push({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '.functions.read:0 {"path":"',
      partial: message,
    });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "toolcall_delta" } });

    // Finish the producer between fragments, while the consumer handles the prefix.
    source.push({ type: "toolcall_delta", contentIndex: 0, delta: 'safe.txt"}', partial: message });
    source.push({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { type: "toolCall", id: "call_read", name: "read", arguments: {} },
      partial: message,
    });
    source.push({ type: "done", reason: "toolUse", message });
    source.end();
    await vi.advanceTimersByTimeAsync(500);
    expect(onIdleTimeout).not.toHaveBeenCalled();
    expect(requestSignal?.aborted).toBe(false);

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "toolcall_delta" } });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "toolcall_end", toolCall: { arguments: { path: "safe.txt" } } },
    });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "done" } });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await expect(stream.result()).resolves.toMatchObject({
      content: [{ arguments: { path: "safe.txt" } }],
    });
  });

  it("does not abort a completed structural stream while the consumer is parked", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const baseFn: StreamFn = vi.fn((_model, _context, options) => {
      requestSignal = options?.signal;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "text_delta", contentIndex: 0, delta: "first" });
      setTimeout(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: makeAgentAssistantMessage({
            content: [{ type: "text", text: "first" }],
            model: "test",
            usage: createZeroUsageFixture(),
            timestamp: 1,
          }),
        });
        stream.end();
      }, 10);
      return {
        result: () => stream.result(),
        [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
      };
    });
    const onIdleTimeout = vi.fn();
    const wrapped = streamWithIdleTimeout(baseFn, 50, onIdleTimeout);
    const stream = wrapped(
      {} as Parameters<typeof baseFn>[0],
      {} as Parameters<typeof baseFn>[1],
      {} as Parameters<typeof baseFn>[2],
    ) as AssistantMessageEventStream;
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });

    // Producer finishes while the consumer has not drained the terminal event.
    await vi.advanceTimersByTimeAsync(500);
    expect(onIdleTimeout).not.toHaveBeenCalled();
    expect(requestSignal?.aborted).toBe(false);
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "done" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });
});
