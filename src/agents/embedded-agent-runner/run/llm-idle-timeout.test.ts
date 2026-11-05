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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { wrapStreamFnRepairMalformedToolCallArguments } from "./attempt.tool-call-argument-repair.js";
import { streamWithIdleTimeout } from "./llm-idle-timeout.js";

function openStream(
  baseFn: StreamFn,
  onTimeout?: Parameters<typeof streamWithIdleTimeout>[2],
  watchdogOptions?: Parameters<typeof streamWithIdleTimeout>[3],
  options: Parameters<StreamFn>[2] = {},
) {
  const streamFn = streamWithIdleTimeout(baseFn, 50, onTimeout, watchdogOptions);
  return streamFn({} as Parameters<StreamFn>[0], {} as Parameters<StreamFn>[1], options);
}

function sourceFixture(
  source: ReturnType<StreamFn> | StreamFn,
  watchdogOptions?: Parameters<typeof streamWithIdleTimeout>[3],
  options?: Parameters<StreamFn>[2],
  decorate: (stream: StreamFn) => StreamFn = (stream) => stream,
) {
  let signal: AbortSignal | undefined;
  const onTimeout = vi.fn();
  const producer: StreamFn = (model, context, request) => {
    signal = request?.signal;
    return typeof source === "function" ? source(model, context, request) : source;
  };
  return {
    stream: openStream(decorate(producer), onTimeout, watchdogOptions, options),
    onTimeout,
    signal: () => signal,
  };
}

function textDelta(delta: string) {
  return { type: "text_delta" as const, contentIndex: 0, delta };
}

async function expectDelta(
  next: Promise<IteratorResult<AssistantMessageEvent>>,
  delay: number,
  delta: string,
) {
  await vi.advanceTimersByTimeAsync(delay);
  await expect(next).resolves.toEqual({ done: false, value: textDelta(delta) });
}

const TEST_RUN = "test-run";
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  clearToolActivityRun(TEST_RUN);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("streamWithIdleTimeout", () => {
  it("keeps watchdog allocations and abort subscriptions bounded across streamed deltas", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const caller = new AbortController();
    const listeners = vi.spyOn(caller.signal, "addEventListener");
    const source = createAssistantMessageEventStream();
    const watched = sourceFixture(source, undefined, { signal: caller.signal });
    const iterator = (await watched.stream)[Symbol.asyncIterator]();
    try {
      for (let index = 0; index < 16; index += 1) {
        const next = iterator.next();
        await vi.advanceTimersByTimeAsync(10);
        notifyLlmRequestActivity(watched.signal());
        const event = textDelta(String(index));
        source.push(event);
        expect((await next).value).toBe(event);
      }
      expect(watched.onTimeout).not.toHaveBeenCalled();
      expect(timers.mock.calls.length).toBeLessThanOrEqual(4);
      expect(listeners.mock.calls.length).toBeLessThanOrEqual(2);
      const pending = iterator.next().catch((error: unknown) => error);
      caller.abort(new Error("cancel after deltas"));
      expect(await pending).toMatchObject({ name: "AbortError", message: "cancel after deltas" });
      await vi.advanceTimersByTimeAsync(100);
      expect(watched.onTimeout).not.toHaveBeenCalled();
    } finally {
      source.end(makeAgentAssistantMessage({ content: [], stopReason: "aborted" }));
      await iterator.return?.();
    }
  });

  it("throws when a promise stream never resolves", async () => {
    const watched = sourceFixture(
      (_model, _context, options) =>
        new Promise<AssistantMessageEventStream>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(toLintErrorObject(options?.signal?.reason, "Non-Error rejection"));
          });
        }),
    );
    const stream = expect(watched.stream).rejects.toThrow(/LLM idle timeout/);
    await vi.advanceTimersByTimeAsync(50);
    await stream;

    expect(watched.onTimeout).toHaveBeenCalledOnce();
    expect(watched.signal()?.aborted).toBe(true);
  });

  it("clears setup state when baseFn throws synchronously", async () => {
    const setupError = new Error("sync provider setup failed");
    const baseFn: StreamFn = () => {
      throw setupError;
    };
    const onIdleTimeout = vi.fn();
    expect(() => openStream(baseFn, onIdleTimeout)).toThrow("sync provider setup failed");
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
          openStream(baseFn, onIdleTimeout, { scope }, options),
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
      const created = createDeferred<AssistantMessageEventStream>();
      const source = createAssistantMessageEventStream();
      const onIdleTimeout = vi.fn();
      const baseFn: StreamFn = (_model, _context, options) => {
        notifyLlmRequestActivity(options?.signal);
        return created.promise;
      };
      const opening = openStream(baseFn, onIdleTimeout);
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
    const created = createDeferred<AssistantMessageEventStream>();
    const source = createAssistantMessageEventStream();
    const onIdleTimeout = vi.fn();
    const baseFn: StreamFn = () => created.promise;
    const opening = openStream(baseFn, onIdleTimeout, { scope: "creation-only" });
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
    const diagnosticsEnabled = areDiagnosticsEnabledForProcess();
    setDiagnosticsEnabledForProcess(true);
    const ref = { sessionId: TEST_RUN, runId: TEST_RUN };
    markDiagnosticEmbeddedRunStarted(ref);
    const watched = sourceFixture(createAssistantMessageEventStream(), { runId: TEST_RUN });
    const iterator = (await watched.stream)[Symbol.asyncIterator]();
    try {
      await vi.advanceTimersByTimeAsync(40);
      notifyLlmRequestActivity(watched.signal(), false);
      expect(getDiagnosticSessionActivitySnapshot(ref).lastProgressReason).toBe(
        "embedded_run:started",
      );
      notifyLlmRequestActivity(watched.signal(), true);
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
    const baseFn: StreamFn = vi.fn((_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      notifyLlmRequestActivity(options?.signal, false);
      setTimeout(() => stream.push(textDelta("done")), 120);
      return stream;
    });
    const stream = await openStream(baseFn, undefined, { runId: TEST_RUN });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();

    setTimeout(() => notifyToolActivity(TEST_RUN), 40);
    setTimeout(() => notifyToolActivity(TEST_RUN), 80);
    await expectDelta(next, 120, "done");
    await iterator.return?.();
  });

  it.each(["structural", "notified", "skew"] as const)(
    "restores the full idle budget after pre-stream tool activity (%s)",
    async (progress) => {
      const chunks =
        progress !== "notified"
          ? ([
              [10, "first"],
              [55, "second"],
              [100, "third"],
              [145, "fourth"],
            ] as const)
          : ([[80, "late"]] as const);
      // The stale timestamp must be consumed once, not shorten later budgets.
      vi.advanceTimersByTime(1);
      notifyToolActivity(TEST_RUN);
      vi.advanceTimersByTime(20);
      if (progress === "skew") {
        vi.setSystemTime(Date.now() + 29);
      }
      const source = createAssistantMessageEventStream();
      for (const [delay, delta] of chunks) {
        setTimeout(() => source.push(textDelta(delta)), delay);
      }
      const watched = sourceFixture(source, { runId: TEST_RUN });
      const iterator = (await watched.stream)[Symbol.asyncIterator]();
      if (progress === "notified") {
        const next = iterator.next();
        setTimeout(() => notifyLlmRequestActivity(watched.signal()), 20);
        setTimeout(() => notifyLlmRequestActivity(watched.signal()), 40);
        await expectDelta(next, 80, "late");
      } else {
        await expectDelta(iterator.next(), 10, "first");
        // Structural yields remain progress beyond the original two idle windows.
        for (const delta of ["second", "third", "fourth"]) {
          await expectDelta(iterator.next(), 45, delta);
        }
      }
      await iterator.return?.();
    },
  );
});

function structuralStream(
  next: () => Promise<IteratorResult<AssistantMessageEvent>>,
): Awaited<ReturnType<StreamFn>> {
  return {
    result: () => new Promise<AssistantMessage>(() => {}),
    [Symbol.asyncIterator]: () => ({ next }),
  };
}

function createNeverYieldingStream(signal?: AbortSignal) {
  return structuralStream(
    () =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("provider abort")), {
          once: true,
        });
      }),
  );
}

describe("streamWithIdleTimeout caller cancellation", () => {
  it.for<{
    phase: "iterator" | "factory";
    honorsAbort?: boolean;
    returning?: boolean;
    alreadyAborted?: boolean;
    accepted?: boolean;
  }>([
    { phase: "iterator", honorsAbort: false },
    { phase: "iterator", honorsAbort: true },
    { phase: "iterator", returning: true },
    { phase: "factory" },
    { phase: "factory", alreadyAborted: true },
    { phase: "factory", accepted: true },
  ])(
    "preempts $phase ($honorsAbort, returning: $returning, aborted: $alreadyAborted, accepted: $accepted)",
    async ({ phase, honorsAbort, returning, alreadyAborted, accepted }) => {
      const caller = new AbortController();
      const callerReason = new Error("caller cancelled");
      if (alreadyAborted) {
        caller.abort(callerReason);
      }
      const watched = sourceFixture(
        (_model, _context, options) => {
          if (phase === "iterator") {
            return createNeverYieldingStream(honorsAbort ? options?.signal : undefined);
          }
          return options?.signal?.aborted
            ? Promise.reject(new Error("provider rejected cancelled setup"))
            : new Promise<AssistantMessageEventStream>(() => {});
        },
        undefined,
        { signal: caller.signal },
      );
      const outcomes: Promise<unknown>[] = [];
      const observe = (outcome: Promise<unknown>) => outcome.catch((error: unknown) => error);
      if (phase === "iterator") {
        const iterator = (await watched.stream)[Symbol.asyncIterator]();
        outcomes.push(observe(iterator.next()), observe(iterator.next()));
        if (returning) {
          await iterator.return?.();
        }
      } else {
        outcomes.push(observe(Promise.resolve(watched.stream)));
        if (accepted) {
          await vi.advanceTimersByTimeAsync(20);
          notifyLlmRequestActivity(watched.signal());
        }
      }
      caller.abort(callerReason);
      for (const outcome of outcomes) {
        await expect(outcome).resolves.toMatchObject({
          name: "AbortError",
          message: callerReason.message,
          cause: callerReason,
        });
      }
      await vi.advanceTimersByTimeAsync(50);
      expect(watched.signal()?.reason).toBe(returning ? undefined : callerReason);
      expect(watched.onTimeout).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, new Error("provider failed"), "provider failed"])(
    "preserves provider error mapping (%s)",
    async (failure) => {
      const caller = new AbortController();
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Providers can reject with non-Error payloads.
      const source = structuralStream(() => Promise.reject(failure));
      const watched = sourceFixture(source, undefined, { signal: caller.signal });
      const stream = await watched.stream;
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
    },
  );
});

describe("streamWithIdleTimeout parked consumer", () => {
  it("preserves argument fragments when the producer completes while the consumer is parked", async () => {
    const source = createAssistantMessageEventStream();
    const message: AssistantMessage = makeAgentAssistantMessage({
      content: [{ type: "toolCall", id: "call_read", name: "read", arguments: {} }],
      api: "openai-chatgpt-responses",
      stopReason: "toolUse",
    });
    // Match attempt-stream's production order: repair inside the watchdog.
    const watched = sourceFixture(
      source,
      undefined,
      undefined,
      wrapStreamFnRepairMalformedToolCallArguments,
    );
    const stream = await watched.stream;
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
    expect(watched.onTimeout).not.toHaveBeenCalled();
    expect(watched.signal()?.aborted).toBe(false);

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
    const watched = sourceFixture(() => {
      const stream = createAssistantMessageEventStream();
      stream.push(textDelta("first"));
      setTimeout(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: makeAgentAssistantMessage({
            content: [{ type: "text", text: "first" }],
          }),
        });
        stream.end();
      }, 10);
      return {
        result: () => stream.result(),
        [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
      };
    });
    const iterator = (await watched.stream)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });

    // Producer finishes while the consumer has not drained the terminal event.
    await vi.advanceTimersByTimeAsync(500);
    expect(watched.onTimeout).not.toHaveBeenCalled();
    expect(watched.signal()?.aborted).toBe(false);
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "done" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });
});
