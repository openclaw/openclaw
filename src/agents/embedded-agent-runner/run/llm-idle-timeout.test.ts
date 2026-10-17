import {
  notifyLlmRequestActivity,
  type FirstStreamEventInternalOptions,
} from "@openclaw/ai/internal/runtime";
import { toErrorObject as toLintErrorObject } from "@openclaw/normalization-core/error-coercion";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
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

const model = {} as Parameters<StreamFn>[0];
const context = {} as Parameters<StreamFn>[1];

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function pendingStream() {
  return {
    created: createDeferred<AssistantMessageEventStream>(),
    source: createAssistantMessageEventStream(),
    onIdleTimeout: vi.fn(),
  };
}

function pushTextAfter(stream: AssistantMessageEventStream, delay: number, delta: string) {
  setTimeout(() => stream.push({ type: "text_delta", contentIndex: 0, delta }), delay);
}

function expectText(next: Promise<IteratorResult<unknown>>, delta: string) {
  return expect(next).resolves.toEqual({
    done: false,
    value: { type: "text_delta", contentIndex: 0, delta },
  });
}

describe("streamWithIdleTimeout", () => {
  const TEST_RUN = "test-run";

  afterEach(() => clearToolActivityRun(TEST_RUN));

  it("throws when a promise stream never resolves", async () => {
    let streamSignal: AbortSignal | undefined;
    const baseFn = vi.fn((_model, _context, options) => {
      streamSignal = options?.signal;
      return new Promise<AssistantMessageEventStream>((_resolve, reject) => {
        streamSignal?.addEventListener("abort", () => {
          reject(toLintErrorObject(streamSignal?.reason, "Non-Error rejection"));
        });
      });
    });
    const onIdleTimeout = vi.fn();
    const wrapped = streamWithIdleTimeout(baseFn, 50, onIdleTimeout);
    const stream = expect(wrapped(model, context)).rejects.toThrow(/LLM idle timeout/);
    await vi.advanceTimersByTimeAsync(50);
    await stream;
    expect([onIdleTimeout.mock.calls.length, streamSignal?.aborted]).toEqual([1, true]);
  });

  it("clears setup state when baseFn throws synchronously", async () => {
    const setupError = new Error("sync provider setup failed");
    const baseFn = vi.fn(() => {
      throw setupError;
    }) as unknown as Parameters<typeof streamWithIdleTimeout>[0];
    const onIdleTimeout = vi.fn();
    const wrapped = streamWithIdleTimeout(baseFn, 50, onIdleTimeout);
    expect(() => wrapped(model, context)).toThrow("sync provider setup failed");
    await vi.advanceTimersByTimeAsync(500);
    expect(onIdleTimeout).not.toHaveBeenCalled();
  });

  it.each(["acceptance", "activity"] as const)(
    "guards a pending cloud factory after provider %s without policing local gaps",
    async (event) => {
      for (const scope of ["creation-and-gaps", "creation-only"] as const) {
        const caller = new AbortController();
        const { created, source, onIdleTimeout } = pendingStream();
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
          firstEventTimeoutMs: 200,
        };
        const opening = Promise.resolve(
          streamWithIdleTimeout(baseFn, 50, onIdleTimeout, { scope })(
            model,
            { messages: [] },
            options,
          ),
        ).catch((error: unknown) => error);
        try {
          await vi.advanceTimersByTimeAsync(20);
          await accept();
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
      const { created, source, onIdleTimeout } = pendingStream();
      const baseFn: StreamFn = (_model, _context, options) => {
        notifyLlmRequestActivity(options?.signal);
        return created.promise;
      };
      const opening = streamWithIdleTimeout(baseFn, 50, onIdleTimeout)(model, { messages: [] });
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
    const { created, source, onIdleTimeout } = pendingStream();
    const baseFn: StreamFn = () => created.promise;
    const opening = streamWithIdleTimeout(baseFn, 50, onIdleTimeout, { scope: "creation-only" })(
      model,
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
    const baseFn: StreamFn = vi.fn((_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      notifyLlmRequestActivity(options?.signal, false);
      pushTextAfter(stream, 120, "done");
      return stream;
    });
    const wrapped = streamWithIdleTimeout(baseFn, 50, undefined, { runId: TEST_RUN });
    const stream = wrapped(model, context) as AssistantMessageEventStream;
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    setTimeout(() => notifyToolActivity(TEST_RUN), 40);
    setTimeout(() => notifyToolActivity(TEST_RUN), 80);
    await vi.advanceTimersByTimeAsync(120);
    await expectText(next, "done");
    await iterator.return?.();
  });

  it.each([
    {
      name: "subsequent chunks",
      chunks: [
        [10, "first"],
        [55, "second"],
      ] as const,
      activity: [],
    },
    { name: "mid-stream LLM activity", chunks: [[80, "late"]] as const, activity: [20, 40] },
  ])(
    "preserves full idle budget for $name after pre-stream tool consumption",
    async ({ chunks, activity }) => {
      let requestSignal: AbortSignal | undefined;
      const baseFn: StreamFn = (_model, _context, options) => {
        requestSignal = options?.signal;
        const stream = createAssistantMessageEventStream();
        for (const [delay, delta] of chunks) {
          pushTextAfter(stream, delay, delta);
        }
        return stream;
      };
      const wrapped = streamWithIdleTimeout(baseFn, 50, undefined, { runId: TEST_RUN });
      notifyToolActivity(TEST_RUN);
      vi.advanceTimersByTime(20);
      const stream = await wrapped(model, context);
      const iterator = stream[Symbol.asyncIterator]();
      for (const delay of activity) {
        setTimeout(() => notifyLlmRequestActivity(requestSignal), delay);
      }
      let elapsed = 0;
      for (const [delay, delta] of chunks) {
        const next = iterator.next();
        await vi.advanceTimersByTimeAsync(delay - elapsed);
        await expectText(next, delta);
        elapsed = delay;
      }
      await iterator.return?.();
    },
  );
});

function createNeverYieldingStream(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<unknown>>(() => {}),
    }),
  };
}

it.each([
  ["iteration", false],
  ["creation", false],
  ["creation", true],
] as const)("preempts provider %s (already aborted: %s)", async (phase, alreadyAborted) => {
  const caller = new AbortController();
  const reason = new Error("caller cancelled");
  if (alreadyAborted) {
    caller.abort(reason);
  }
  const baseFn = vi.fn((_model, _context, options?: { signal?: AbortSignal }) => {
    if (phase === "iteration") {
      return createNeverYieldingStream();
    }
    return options?.signal?.aborted
      ? Promise.reject(new Error("provider rejected cancelled setup"))
      : new Promise<AssistantMessageEventStream>(() => {});
  });
  const onIdleTimeout = vi.fn();
  const opening = streamWithIdleTimeout(baseFn as StreamFn, 50, onIdleTimeout)(model, context, {
    signal: caller.signal,
  });
  const pending =
    phase === "iteration"
      ? (opening as AsyncIterable<unknown>)[Symbol.asyncIterator]().next()
      : opening;
  caller.abort(reason);
  await expect(pending).rejects.toMatchObject({
    name: "AbortError",
    message: reason.message,
    cause: reason,
  });
  await vi.advanceTimersByTimeAsync(50);
  expect([baseFn.mock.calls[0]?.[2]?.signal?.reason, onIdleTimeout.mock.calls.length]).toEqual([
    reason,
    0,
  ]);
});

it("preserves argument fragments when the producer completes while the consumer is parked", async () => {
  const source = createAssistantMessageEventStream();
  const message: AssistantMessage = makeAgentAssistantMessage({
    content: [{ type: "toolCall", id: "call_read", name: "read", arguments: {} }],
    api: "openai-chatgpt-responses",
    model: "test",
    stopReason: "toolUse",
    timestamp: 1,
  });
  let requestSignal: AbortSignal | undefined;
  const baseFn: StreamFn = (_model, _context, options) => {
    requestSignal = options?.signal;
    return source;
  };
  const onIdleTimeout = vi.fn();
  // Production order: argument repair stays inside the watchdog.
  const wrapped = streamWithIdleTimeout(
    wrapStreamFnRepairMalformedToolCallArguments(baseFn),
    50,
    onIdleTimeout,
  );
  const stream = await wrapped(model, context, {});
  const iterator = stream[Symbol.asyncIterator]();
  source.push({
    type: "toolcall_delta",
    contentIndex: 0,
    delta: '.functions.read:0 {"path":"',
    partial: message,
  });
  await expect(iterator.next()).resolves.toMatchObject({ value: { type: "toolcall_delta" } });
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
