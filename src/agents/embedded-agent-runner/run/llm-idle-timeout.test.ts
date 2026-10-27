import {
  notifyLlmRequestActivity,
  type FirstStreamEventInternalOptions,
} from "@openclaw/ai/internal/runtime";
import { toErrorObject as toLintErrorObject } from "@openclaw/normalization-core/error-coercion";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyProviderStreamOpened } from "../../../../packages/ai/src/transports/transport-stream-shared.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../../infra/diagnostic-events.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  resetDiagnosticRunActivityForTest,
} from "../../../logging/diagnostic-run-activity.js";
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
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps watchdog allocations and abort subscriptions bounded across streamed deltas", async () => {
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, "setTimeout");
    const caller = new AbortController();
    const listeners = vi.spyOn(caller.signal, "addEventListener");
    const source = createAssistantMessageEventStream();
    let signal: AbortSignal | undefined;
    const baseFn: StreamFn = (_model, _context, options) => {
      signal = options?.signal;
      return source;
    };
    const onTimeout = vi.fn();
    const stream = await streamWithIdleTimeout(baseFn, 50, onTimeout)(
      {} as Parameters<StreamFn>[0],
      { messages: [] },
      { signal: caller.signal },
    );
    const iterator = stream[Symbol.asyncIterator]();
    try {
      for (let index = 0; index < 16; index += 1) {
        const next = iterator.next();
        await vi.advanceTimersByTimeAsync(10);
        notifyLlmRequestActivity(signal);
        const event = { type: "text_delta" as const, contentIndex: 0, delta: String(index) };
        source.push(event);
        expect((await next).value).toBe(event);
      }
      expect(onTimeout).not.toHaveBeenCalled();
      expect(timers.mock.calls.length).toBeLessThanOrEqual(4);
      expect(listeners.mock.calls.length).toBeLessThanOrEqual(2);
      const pending = iterator.next().catch((error: unknown) => error);
      caller.abort(new Error("cancel after deltas"));
      expect(await pending).toMatchObject({ name: "AbortError", message: "cancel after deltas" });
      await vi.advanceTimersByTimeAsync(100);
      expect(onTimeout).not.toHaveBeenCalled();
    } finally {
      source.end(makeAgentAssistantMessage({ content: [], stopReason: "aborted" }));
      await iterator.return?.();
    }
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

  it.each([
    { event: "acceptance", firstEventTimeoutMs: 50 },
    { event: "activity", firstEventTimeoutMs: 50 },
    { event: "acceptance", firstEventTimeoutMs: 200 },
    { event: "activity", firstEventTimeoutMs: 200 },
  ] as const)(
    "guards a pending factory after $event with a $firstEventTimeoutMs ms creation budget",
    async ({ event, firstEventTimeoutMs }) => {
      vi.useFakeTimers();
      const timers = vi.spyOn(globalThis, "setTimeout");
      for (const scope of ["creation-and-gaps", "creation-only"] as const) {
        timers.mockClear();
        const caller = new AbortController();
        const created = createDeferred<AssistantMessageEventStream>();
        const source = createAssistantMessageEventStream();
        const onIdleTimeout = vi.fn();
        let requestSignal: AbortSignal | undefined;
        let accept: () => void | Promise<void> = () => {};
        const baseFn: StreamFn = (_model, _context, options) => {
          requestSignal = options?.signal;
          accept = () =>
            event === "activity"
              ? notifyLlmRequestActivity(requestSignal)
              : notifyProviderStreamOpened({ options, cancelStream: () => {} });
          return created.promise;
        };
        const options: NonNullable<Parameters<StreamFn>[2]> & FirstStreamEventInternalOptions = {
          signal: caller.signal,
          firstEventTimeoutMs,
        };
        const opening = Promise.resolve(
          streamWithIdleTimeout(baseFn, 50, onIdleTimeout, { scope })(
            {} as Parameters<StreamFn>[0],
            { messages: [] },
            options,
          ),
        ).catch((error: unknown) => error);
        try {
          await vi.advanceTimersByTimeAsync(20);
          await accept();
          expect(timers).toHaveBeenCalledTimes(
            scope === "creation-and-gaps" && firstEventTimeoutMs !== 50 ? 2 : 1,
          );
          await vi.advanceTimersByTimeAsync(49);
          expect(onIdleTimeout).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          if (scope === "creation-and-gaps") {
            expect(onIdleTimeout).toHaveBeenCalledOnce();
            expect(await opening).toBe(onIdleTimeout.mock.calls[0]?.[0]);
            expect(requestSignal?.aborted).toBe(true);
          } else {
            await vi.advanceTimersByTimeAsync(500);
            expect(onIdleTimeout).not.toHaveBeenCalled();
            expect(requestSignal?.aborted).toBe(false);
            created.resolve(source);
            expect(await opening).toBe(source);
          }
        } finally {
          caller.abort();
          source.end(makeAgentAssistantMessage({ content: [], stopReason: "aborted" }));
          created.resolve(source);
          await opening;
        }
      }
    },
  );

  it.each([false, true])(
    "keeps the accepted deadline until the iterator watchdog takes over (consume: %s)",
    async (consume) => {
      vi.useFakeTimers();
      const created = createDeferred<AssistantMessageEventStream>();
      const source = createAssistantMessageEventStream();
      const onIdleTimeout = vi.fn();
      const baseFn: StreamFn = (_model, _context, options) => {
        notifyLlmRequestActivity(options?.signal);
        return created.promise;
      };
      const opening = streamWithIdleTimeout(
        baseFn,
        50,
        onIdleTimeout,
      )({} as Parameters<StreamFn>[0], { messages: [] });
      await vi.advanceTimersByTimeAsync(20);
      created.resolve(source);
      const stream = await opening;
      const iterator = stream[Symbol.asyncIterator]();
      try {
        await vi.advanceTimersByTimeAsync(29);
        expect(onIdleTimeout).not.toHaveBeenCalled();
        const next = consume ? iterator.next().catch((error: unknown) => error) : undefined;
        if (consume) {
          await vi.advanceTimersByTimeAsync(49);
          expect(onIdleTimeout).not.toHaveBeenCalled();
        }
        await vi.advanceTimersByTimeAsync(1);
        expect(onIdleTimeout).toHaveBeenCalledOnce();
        const outcome = next ?? iterator.next().catch((error: unknown) => error);
        expect(await outcome).toBe(onIdleTimeout.mock.calls[0]?.[0]);
      } finally {
        source.end(makeAgentAssistantMessage({ content: [], stopReason: "aborted" }));
        await iterator.return?.();
      }
      await vi.advanceTimersByTimeAsync(500);
      expect(onIdleTimeout).toHaveBeenCalledOnce();
    },
  );

  it("keeps one local creation deadline when an async producer returns before headers", async () => {
    vi.useFakeTimers();
    const created = createDeferred<AssistantMessageEventStream>();
    const source = createAssistantMessageEventStream();
    const onIdleTimeout = vi.fn();
    const baseFn: StreamFn = () => created.promise;
    const opening = streamWithIdleTimeout(baseFn, 50, onIdleTimeout, { scope: "creation-only" })(
      {} as Parameters<StreamFn>[0],
      { messages: [] },
    );
    await vi.advanceTimersByTimeAsync(40);
    created.resolve(source);
    const stream = await opening;
    const next = stream[Symbol.asyncIterator]()
      .next()
      .catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(9);
      expect(onIdleTimeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onIdleTimeout).toHaveBeenCalledOnce();
      expect(await next).toBe(onIdleTimeout.mock.calls[0]?.[0]);
    } finally {
      source.end(makeAgentAssistantMessage({ content: [], stopReason: "aborted" }));
      await next;
    }
  });

  it("records model progress only for content-bearing activity", async () => {
    vi.useFakeTimers();
    const diagnosticsEnabled = areDiagnosticsEnabledForProcess();
    setDiagnosticsEnabledForProcess(true);
    const ref = { sessionId: TEST_RUN, runId: TEST_RUN };
    markDiagnosticEmbeddedRunStarted(ref);
    let requestSignal: AbortSignal | undefined;
    const baseFn: StreamFn = (_model, _context, options) => {
      requestSignal = options?.signal;
      return createAssistantMessageEventStream();
    };
    const stream = await streamWithIdleTimeout(baseFn, 50, undefined, { runId: TEST_RUN })(
      {} as Parameters<StreamFn>[0],
      { messages: [] },
    );
    const iterator = stream[Symbol.asyncIterator]();
    try {
      await vi.advanceTimersByTimeAsync(40);
      notifyLlmRequestActivity(requestSignal, false);
      expect(getDiagnosticSessionActivitySnapshot(ref).lastProgressReason).toBe(
        "embedded_run:started",
      );
      notifyLlmRequestActivity(requestSignal, true);
      expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
        lastProgressAgeMs: 0,
        lastProgressReason: "model_call:stream_progress",
      });
    } finally {
      await iterator.return?.();
      resetDiagnosticRunActivityForTest();
      setDiagnosticsEnabledForProcess(diagnosticsEnabled);
    }
  });

  it("resets idle timer on tool activity", async () => {
    vi.useFakeTimers();
    const baseFn: StreamFn = vi.fn((_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      notifyLlmRequestActivity(options?.signal, false);
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

  it("preserves structural stream progress beyond two idle windows after pre-stream tool activity", async () => {
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
      for (const [delay, delta] of [
        [100, "third"],
        [145, "fourth"],
      ] as const) {
        setTimeout(() => stream.push({ type: "text_delta", contentIndex: 0, delta }), delay);
      }
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

    // Structural producers have no physical-activity notifier. Consuming real
    // output remains their progress owner, even beyond the original 100ms limit.
    for (const delta of ["third", "fourth"]) {
      const next = iterator.next();
      await vi.advanceTimersByTimeAsync(45);
      await expect(next).resolves.toEqual({
        done: false,
        value: { type: "text_delta", contentIndex: 0, delta },
      });
    }
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

function createNeverYieldingStream(signal?: AbortSignal): Awaited<ReturnType<StreamFn>> {
  return {
    result: () => new Promise<AssistantMessage>(() => {}),
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return new Promise<IteratorResult<AssistantMessageEvent>>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("provider abort")), {
              once: true,
            });
          });
        },
      };
    },
  };
}

describe("streamWithIdleTimeout caller cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { honorsAbort: false, returning: false },
    { honorsAbort: true, returning: false },
    { honorsAbort: false, returning: true },
  ])(
    "preempts pending iterators ($honorsAbort, returning: $returning)",
    async ({ honorsAbort, returning }) => {
      vi.useFakeTimers();
      const callerAbortController = new AbortController();
      const callerReason = new Error("caller cancelled");
      const baseFn = vi.fn<StreamFn>((_model, _context, options) =>
        createNeverYieldingStream(honorsAbort ? options?.signal : undefined),
      );
      const onIdleTimeout = vi.fn();
      const iterator = (
        streamWithIdleTimeout(baseFn, 50, onIdleTimeout)(
          {} as Parameters<typeof baseFn>[0],
          {} as Parameters<typeof baseFn>[1],
          { signal: callerAbortController.signal },
        ) as AsyncIterable<unknown>
      )[Symbol.asyncIterator]();
      const outcome = iterator.next().catch((error: unknown) => error);
      const overlapping = iterator.next().catch((error: unknown) => error);

      if (returning) {
        await iterator.return?.();
      }

      callerAbortController.abort(callerReason);

      await expect(outcome).resolves.toMatchObject({
        name: "AbortError",
        message: callerReason.message,
        cause: callerReason,
      });
      await expect(overlapping).resolves.toMatchObject({
        name: "AbortError",
        message: callerReason.message,
        cause: callerReason,
      });
      await vi.advanceTimersByTimeAsync(50);
      const providerSignal = (baseFn.mock.calls.at(0)?.[2] as { signal?: AbortSignal } | undefined)
        ?.signal;
      expect(providerSignal?.reason).toBe(returning ? undefined : callerReason);
      expect(onIdleTimeout).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, new Error("provider failed"), "provider failed"])(
    "preserves provider error mapping (%s)",
    async (failure) => {
      const caller = new AbortController();
      const source = createAssistantMessageEventStream();
      const original = source[Symbol.asyncIterator].bind(source);
      source[Symbol.asyncIterator] = () => {
        const iterator = original();
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Providers can reject with non-Error payloads.
        iterator.next = () => Promise.reject(failure);
        return iterator;
      };
      const baseFn: StreamFn = () => source;
      const stream = await streamWithIdleTimeout(baseFn, 50)(
        {} as Parameters<StreamFn>[0],
        { messages: [] },
        { signal: caller.signal },
      );
      const error = await stream[Symbol.asyncIterator]()
        .next()
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      if (failure instanceof Error) {
        expect(error).toBe(failure);
      } else {
        expect(error).toMatchObject({
          message: typeof failure === "string" ? failure : "Non-Error rejection",
        });
      }
      source.end(makeAgentAssistantMessage({ content: [], stopReason: "error" }));
    },
  );

  it.each([
    { alreadyAborted: false, accepted: false },
    { alreadyAborted: true, accepted: false },
    { alreadyAborted: false, accepted: true },
  ])(
    "preempts provider stream creation (already aborted: $alreadyAborted, accepted: $accepted)",
    async ({ alreadyAborted, accepted }) => {
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
      const providerSignal = (
        baseFnMock.mock.calls.at(0)?.[2] as { signal?: AbortSignal } | undefined
      )?.signal;
      if (accepted) {
        await vi.advanceTimersByTimeAsync(20);
        notifyLlmRequestActivity(providerSignal);
      }

      callerAbortController.abort(callerReason);

      await expect(pending).rejects.toMatchObject({
        name: "AbortError",
        message: callerReason.message,
        cause: callerReason,
      });
      await vi.advanceTimersByTimeAsync(50);
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
