import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEvent,
} from "openclaw/plugin-sdk/llm";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPrivateData,
  type DiagnosticEventMetadata,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import { resolveCoreModelRequestLifecycleDiagnosticMetadata } from "../../../infra/diagnostic-model-request.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import {
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "../../../logging/diagnostic-run-activity.js";
import { resetGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";
import { createModelObserver } from "./attempt.model-diagnostic-observation.js";

function wrap(
  streamFn: StreamFn,
  context: Partial<Parameters<typeof wrapStreamFnWithDiagnosticModelCallEvents>[1]> = {},
) {
  return wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
    runId: "run-1",
    provider: "openai",
    model: "gpt-5.4",
    trace: createDiagnosticTraceContext(),
    nextCallId: () => "call-1",
    ...context,
  });
}

async function collectModelCallEvents(
  run: () => Promise<void>,
  onEvent?: (event: DiagnosticEventPayload, metadata: DiagnosticEventMetadata) => void,
): Promise<DiagnosticEventPayload[]> {
  const events: DiagnosticEventPayload[] = [];
  const stop = onInternalDiagnosticEvent((event, metadata) => {
    onEvent?.(event, metadata);
    if (event.type.startsWith("model.call.")) {
      events.push(event);
    }
  });
  try {
    await run();
    await yieldToEventLoop();
    return events;
  } finally {
    stop();
  }
}

async function collectTrustedModelCallEvents(run: () => Promise<void>) {
  const events: Array<{
    event: DiagnosticEventPayload;
    privateData: DiagnosticEventPrivateData;
  }> = [];
  const stop = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
    if (event.type.startsWith("model.call.")) {
      events.push({ event, privateData });
    }
  });
  try {
    await run();
    await yieldToEventLoop();
    return events;
  } finally {
    stop();
  }
}

function assistantResult(stopReason: string, content: unknown[]) {
  return { role: "assistant", stopReason, content };
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    // drain
  }
}

const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");

function expectNumberField(record: Record<string, unknown>, key: string) {
  expect(typeof record[key]).toBe("number");
}

function getEvent(events: readonly DiagnosticEventPayload[], index: number) {
  return requireRecord(events[index], `event ${index}`);
}

describe("wrapStreamFnWithDiagnosticModelCallEvents stream proxy", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticRunActivityForTest();
    startDiagnosticRunActivityTracking();
    resetGlobalHookRunner();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    resetGlobalHookRunner();
    resetDiagnosticRunActivityForTest();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("observes and yields the same iterator value without reading it twice", async () => {
    const model = makeProviderModelFixture({
      id: "test-model",
      provider: "test-provider",
      api: "openai-responses",
      baseUrl: "https://example.invalid",
    });
    const firstChunk: AssistantMessageEvent = {
      type: "text_delta",
      contentIndex: 0,
      delta: "first",
    };
    const readChunk = vi
      .fn<() => AssistantMessageEvent>()
      .mockReturnValueOnce(firstChunk)
      .mockReturnValue({ type: "text_delta", contentIndex: 0, delta: "second value" });
    const source: Awaited<ReturnType<StreamFn>> = {
      [Symbol.asyncIterator]() {
        let emitted = false;
        return {
          async next(): Promise<IteratorResult<AssistantMessageEvent>> {
            if (emitted) {
              return { done: true, value: undefined };
            }
            emitted = true;
            return {
              done: false,
              get value() {
                return readChunk();
              },
            };
          },
        };
      },
      async result() {
        return makeAssistantMessageFixture({
          content: [{ type: "text", text: "first" }],
          stopReason: "stop",
          errorMessage: undefined,
        });
      },
    };
    const wrapped = wrap(() => source, {
      provider: model.provider,
      model: model.id,
    });
    const chunks: AssistantMessageEvent[] = [];
    const events = await collectModelCallEvents(async () => {
      const response = await wrapped(model, { messages: [] });
      for await (const chunk of response) {
        chunks.push(chunk);
      }
      await response.result();
    });

    expect(chunks).toEqual([firstChunk]);
    expect(readChunk).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
    expect(events[1]).toMatchObject({
      responseStreamBytes: Buffer.byteLength(firstChunk.delta, "utf8"),
    });
  });

  it("normalizes the timeout from each exact model request", async () => {
    let callSequence = 0;
    const requestTimeouts: Array<number | undefined> = [];
    const wrapped = wrap(
      (() =>
        (async function* () {
          yield { type: "text", text: "ok" };
        })()) as unknown as StreamFn,
      {
        runId: "run-timeouts",
        sessionKey: "session-key",
        sessionId: "session-id",
        nextCallId: () => `call-${++callSequence}`,
        ownerGeneration: Object.freeze({}),
        requestTimeoutMs: 45_000,
      },
    );

    await collectModelCallEvents(
      async () => {
        for (const requestTimeoutMs of [60_000, undefined, 90_000, Number.MAX_SAFE_INTEGER, -1]) {
          await drain(await wrapped({ requestTimeoutMs } as never, {} as never, {} as never));
        }
      },
      (event, metadata) => {
        if (event.type === "model.call.started") {
          const lifecycle = resolveCoreModelRequestLifecycleDiagnosticMetadata(metadata);
          requestTimeouts.push(
            lifecycle?.phase === "started" ? lifecycle.requestTimeoutMs : undefined,
          );
        }
      },
    );

    expect(requestTimeouts).toEqual([60_000, 45_000, 90_000, MAX_TIMER_TIMEOUT_MS, undefined]);
  });

  it.each([
    { stopReason: "stop", resultFirst: false, terminalType: "model.call.completed" },
    { stopReason: "error", resultFirst: true, terminalType: "model.call.error" },
  ])(
    "closes the $stopReason iterator with resultFirst=$resultFirst",
    async ({ stopReason, resultFirst, terminalType }) => {
      // Awaiting result() must still close an abandoned provider iterator.
      let returnCalled = false;
      const assistant = { role: "assistant", content: "ok", stopReason };
      const terminalEvent =
        stopReason === "stop"
          ? { type: "done", reason: stopReason, message: assistant }
          : { type: "error", reason: stopReason, error: assistant };
      const stream = {
        [Symbol.asyncIterator]() {
          let emitted = false;
          return {
            async next() {
              if (!emitted) {
                emitted = true;
                return { value: terminalEvent, done: false };
              }
              return { value: undefined, done: true };
            },
            async return() {
              returnCalled = true;
              return { value: undefined, done: true };
            },
          };
        },
        result: async () => assistant,
      };
      const wrapped = wrap((() => stream) as unknown as StreamFn);

      const events = await collectModelCallEvents(async () => {
        const response = wrapped({} as never, {} as never, {} as never) as unknown as typeof stream;
        const earlyResult = resultFirst ? await response.result() : undefined;
        for await (const event of response as AsyncIterable<{ type: string }>) {
          expect(event).toBe(terminalEvent);
          const result = resultFirst ? earlyResult : await response.result();
          expect(result).toBe(assistant);
          break;
        }
      });

      expect(returnCalled).toBe(true);
      expect(events.map((event) => event.type)).toEqual(["model.call.started", terminalType]);
    },
  );

  it("emits error events when stream iteration fails", async () => {
    const requestId = "req_provider_123";
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<unknown>> {
            throw new TypeError(`provider failed [request_id=${requestId}]`);
          },
        };
      },
    };
    const wrapped = wrap((() => stream) as unknown as StreamFn);

    const events = await collectModelCallEvents(async () => {
      await expect(
        drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>),
      ).rejects.toThrow("provider failed");
    });

    expect(events.map((event) => event.type)).toEqual(["model.call.started", "model.call.error"]);
    const errorEvent = getEvent(events, 1);
    expect(errorEvent.type).toBe("model.call.error");
    expect(errorEvent.callId).toBe("call-1");
    expect(errorEvent.errorCategory).toBe("TypeError");
    expect(errorEvent.upstreamRequestIdHash).toMatch(/^sha256:[a-f0-9]{12}$/);
    expectNumberField(errorEvent, "durationMs");
    expect(JSON.stringify(events[1])).not.toContain(requestId);
  });

  it("does not mutate non-configurable provider streams", async () => {
    const stream = {};
    Object.defineProperty(stream, Symbol.asyncIterator, {
      configurable: false,
      async *value() {
        yield { type: "text", text: "ok" };
      },
    });
    Object.freeze(stream);
    const wrapped = wrap((() => stream) as unknown as StreamFn);

    const events = await collectModelCallEvents(async () => {
      const returned = wrapped(
        {} as never,
        {} as never,
        {} as never,
      ) as unknown as AsyncIterable<unknown>;
      expect(returned).not.toBe(stream);
      await drain(returned);
    });

    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
  });

  it.each([
    { stopReason: "reject", terminalType: "model.call.error" },
    { stopReason: "error", terminalType: "model.call.error" },
    { stopReason: "stop", terminalType: "model.call.completed" },
  ] as const)(
    "classifies bare EOF with $stopReason for every consumer",
    async ({ stopReason, terminalType }) => {
      // Exercise the actual producer contract: end() rejects, while end(message)
      // resolves without yielding a terminal event. Workers may only drain events.
      for (const readResult of [false, true]) {
        const originalStream = createAssistantMessageEventStream();
        if (stopReason === "reject") {
          originalStream.end();
        } else {
          originalStream.end(
            makeAssistantMessageFixture({
              content: [{ type: "text", text: "partial" }],
              stopReason,
              errorMessage: "connection reset [request_id=req_eof_proof]",
            }),
          );
        }
        const result = vi.spyOn(originalStream, "result");
        const wrapped = wrap(() => originalStream, {
          model: "gpt-5.6-luna",
          nextCallId: () => `call-eof-${readResult}`,
        });
        const events = await collectModelCallEvents(async () => {
          const response = await wrapped({} as never, { messages: [] });
          await drain(response);
          if (readResult) {
            const firstResult = response.result();
            expect(response.result()).toBe(firstResult);
            if (stopReason === "reject") {
              await expect(firstResult).rejects.toThrow(
                "event stream ended without a terminal event or final result",
              );
            } else {
              await expect(firstResult).resolves.toMatchObject({ stopReason });
            }
          }
        });
        expect(result).toHaveBeenCalledOnce();
        expect(events.map((event) => event.type)).toEqual(["model.call.started", terminalType]);
        if (stopReason === "error") {
          expect(events[1]).toMatchObject({
            failureKind: "connection_reset",
            upstreamRequestIdHash: expect.stringMatching(/^sha256:[a-f0-9]{12}$/),
          });
        }
      }
    },
  );

  it("retains delayed result work through owner close", async () => {
    const work = new AsyncWorkScope();
    const gate = createDeferredCore();
    const source = createAssistantMessageEventStream();
    source.end();
    const nativeResult = source.result.bind(source);
    source.result = async () => {
      await gate.promise;
      return nativeResult();
    };
    const wrapped = wrap(() => source, {
      model: "gpt-5.6-luna",
    });
    const events = await collectModelCallEvents(async () => {
      const response = await wrapped({} as never, { messages: [] });
      await work.run(() => drain(response));
      let closed = false;
      const closing = work.drain().then(() => {
        closed = true;
      });
      try {
        await yieldToEventLoop();
        expect(closed).toBe(false);
      } finally {
        gate.resolve();
        await closing;
      }
    });
    expect(events.map((event) => event.type)).toEqual(["model.call.started", "model.call.error"]);
  });
  it("preserves exact diagnostic sizes for mixed JSON values", () => {
    const value = {
      small: "short",
      large: (
        Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).join("") +
        '"\\日本語 café 🦞\ud800x\udfff'
      ).repeat(128),
      omitted: undefined,
      array: [undefined, Number.NaN, Symbol("omitted")],
      date: new Date("2026-01-01T00:00:00Z"),
      custom: { toJSON: (key: string) => key.repeat(1024) },
    };
    const messages = [{ role: "user", content: value }];
    const observer = createModelObserver({
      streamContext: { messages, tools: [value] },
      capturePromptStats: true,
    });
    observer.assignRequestPayloadBytes(value);
    observer.observeResponseChunk(Date.now(), value);

    expect(observer.promptStats?.inputMessagesChars).toBe(JSON.stringify(messages).length);
    expect(observer.promptStats?.toolDefinitionsChars).toBe(JSON.stringify([value]).length);
    expect(observer.sizeTimingFields()).toMatchObject({
      requestPayloadBytes: Buffer.byteLength(JSON.stringify(value), "utf8"),
      responseStreamBytes: Buffer.byteLength(JSON.stringify(value), "utf8"),
    });
  });

  it("does not assemble multi-megabyte JSON strings just to measure messages", () => {
    const messages = Array.from({ length: 128 }, (_, index) => ({
      role: "user",
      content: `${index}: ${'A "quoted" line.\n'.repeat(1024)}`,
    }));
    const expectedChars = JSON.stringify(messages).length;
    const expectedBytes = Buffer.byteLength(JSON.stringify({ messages }), "utf8");
    const stringify = vi.spyOn(JSON, "stringify");
    const observer = createModelObserver({
      streamContext: { messages },
      capturePromptStats: true,
    });
    observer.assignRequestPayloadBytes({ messages });
    const largestJsonString = Math.max(
      ...stringify.mock.results.map(({ value }) => (typeof value === "string" ? value.length : 0)),
    );
    stringify.mockRestore();

    expect(observer.promptStats?.inputMessagesChars).toBe(expectedChars);
    expect(observer.sizeTimingFields().requestPayloadBytes).toBe(expectedBytes);
    expect(largestJsonString).toBeLessThan(64 * 1024);
  });

  it("orders semantic results between repeated request observations", async () => {
    const ref = {
      sessionId: "session-semantic-order",
      sessionKey: "agent:main:semantic-order",
    };
    const runId = "run-semantic-order";
    const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
    const results = [
      assistantResult("toolUse", [
        { type: "thinking", thinking: "working" },
        { type: "text", text: "  \n" },
        { type: "toolCall", id: "", name: "read" },
      ]),
      assistantResult("aborted", [{ type: "text", text: "retry two" }]),
      assistantResult("toolUse", [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]),
      assistantResult("error", [{ type: "text", text: "retry after progress" }]),
      assistantResult("error", [{ type: "text", text: "still failing" }]),
    ];
    let callSequence = 0;
    const wrapped = wrap(
      (() => {
        const result = results.shift();
        return {
          async *[Symbol.asyncIterator]() {},
          result: async () => result,
        };
      }) as unknown as StreamFn,
      {
        ...ref,
        runId,
        nextCallId: () => `${runId}:${(callSequence += 1)}`,
        ownerGeneration: owner.generation,
      },
    );
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner });

    const repeatedRequestAges: Array<number | undefined> = [];
    for (let index = 0; index < 5; index += 1) {
      const observed = wrapped({} as never, {} as never, {} as never) as unknown as {
        result: () => Promise<unknown>;
      };
      await observed.result();
      await waitForDiagnosticEventsDrained();
      repeatedRequestAges.push(
        getDiagnosticSessionActivitySnapshot(ref).repeatedRequestNoProgressAgeMs,
      );
    }

    expect(repeatedRequestAges).toEqual([
      undefined,
      expect.any(Number),
      undefined,
      undefined,
      expect.any(Number),
    ]);

    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      hasActiveEmbeddedRun: true,
      repeatedRequestNoProgressAgeMs: expect.any(Number),
    });
  });

  it("updates diagnostic run activity from throttled stream chunks", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    async function* stream() {
      yield { type: "text_delta", delta: "first" };
      yield { type: "text_delta", delta: "second" };
      yield { type: "text_delta", delta: "third" };
    }
    const runProgressEvents: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((event) => {
      if (event.type === "run.progress") {
        runProgressEvents.push(event);
      }
    });
    const wrapped = wrap((() => stream()) as unknown as StreamFn, {
      sessionKey: "session-key",
      sessionId: "session-id",
      provider: "vllm",
      model: "qwen/qwen3.5-9b",
    });

    const returned = wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>;
    const iterator = returned[Symbol.asyncIterator]();

    try {
      for (const [elapsed, count] of [
        [0, 1],
        [10_000, 1],
        [30_000, 2],
      ] as const) {
        now += elapsed;
        await iterator.next();
        await waitForDiagnosticEventsDrained();
        expect(
          getDiagnosticSessionActivitySnapshot({
            sessionKey: "session-key",
            sessionId: "session-id",
          }),
        ).toMatchObject({
          activeWorkKind: "model_call",
          lastProgressReason: "model_call:stream_progress",
          lastProgressAgeMs: 0,
        });
        expect(runProgressEvents).toHaveLength(count);
      }
      expect(runProgressEvents.every((event) => event.type === "run.progress")).toBe(true);
      expect(runProgressEvents.every((event) => !("progressKind" in event))).toBe(true);
    } finally {
      await iterator.return?.();
      await waitForDiagnosticEventsDrained();
      stop();
    }
  });

  it("counts async onPayload replacements instead of raw payload content", async () => {
    async function* stream() {
      yield { type: "text_delta", delta: "safe" };
    }
    const originalPayload = { input: "secret sk-original-secret" };
    const replacementPayload = { input: "redacted" };
    const wrapped = wrap((async (
      model: Parameters<StreamFn>[0],
      _context: Parameters<StreamFn>[1],
      options: Parameters<StreamFn>[2],
    ) => {
      await options?.onPayload?.(originalPayload, model);
      return stream();
    }) as unknown as StreamFn);

    const events = await collectModelCallEvents(async () => {
      const streamResult = await wrapped({} as never, {} as never, {
        onPayload: async () => replacementPayload,
      });
      await drain(streamResult as unknown as AsyncIterable<unknown>);
    });

    const completedEvent = getEvent(events, 1);
    expect(completedEvent.type).toBe("model.call.completed");
    expect(completedEvent.callId).toBe("call-1");
    expect(completedEvent.requestPayloadBytes).toBe(
      Buffer.byteLength(JSON.stringify(replacementPayload), "utf8"),
    );
    expectNumberField(completedEvent, "responseStreamBytes");
    expectNumberField(completedEvent, "timeToFirstByteMs");
    expect(JSON.stringify(events)).not.toContain("sk-original-secret");
  });

  it("counts text deltas without serializing full partial snapshots", async () => {
    const serializedPartial = vi.fn(() => {
      throw new Error("partial snapshot should not be serialized for text deltas");
    });
    async function* stream() {
      for (const [delta, text] of [
        ["a", "a"],
        ["bc", "abc"],
      ] as const) {
        yield {
          type: "text_delta",
          contentIndex: 0,
          delta,
          partial: {
            toJSON: serializedPartial,
            role: "assistant",
            content: [{ type: "text", text: text.repeat(200_000) }],
          },
        };
      }
    }
    const wrapped = wrap((() => stream()) as unknown as StreamFn);

    const events = await collectModelCallEvents(async () => {
      await drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
    });

    const completedEvent = getEvent(events, 1);
    expect(completedEvent.type).toBe("model.call.completed");
    expect(completedEvent.responseStreamBytes).toBe(Buffer.byteLength("abc", "utf8"));
    expect(serializedPartial).not.toHaveBeenCalled();
  });

  it("keeps streams alive when diagnostic byte inspection cannot read a chunk", async () => {
    const opaqueChunk = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "then") {
            return undefined;
          }
          throw new Error("chunk should not be inspected");
        },
      },
    );
    async function* stream() {
      yield opaqueChunk;
      yield { type: "text_delta", delta: "ok" };
    }
    const wrapped = wrap((() => stream()) as unknown as StreamFn);

    const chunks: unknown[] = [];
    const events = await collectModelCallEvents(async () => {
      for await (const chunk of wrapped(
        {} as never,
        {} as never,
        {} as never,
      ) as AsyncIterable<unknown>) {
        chunks.push(chunk);
      }
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(opaqueChunk);
    expect(chunks[1]).toEqual({ type: "text_delta", delta: "ok" });
    const completedEvent = getEvent(events, 1);
    expect(completedEvent.type).toBe("model.call.completed");
    expect(completedEvent.responseStreamBytes).toBe(Buffer.byteLength("ok", "utf8"));
  });

  it("captures model input, tools, and output only when content capture is enabled", async () => {
    const assistant = assistantResult("stop", [{ type: "text", text: "trace reply" }]);
    async function* stream() {
      yield { type: "done", reason: "stop", message: assistant };
    }
    const source = Object.assign(stream(), { result: async () => assistant });
    const wrapped = wrap((() => source) as unknown as StreamFn, {
      contentCapture: {
        inputMessages: true,
        outputMessages: true,
        toolInputs: false,
        toolOutputs: false,
        systemPrompt: true,
        toolDefinitions: true,
        anyModelContent: true,
      },
    });

    const inputMessages = [{ role: "user", content: "trace prompt", timestamp: 1 }];
    const tools = [{ name: "lookup", description: "Lookup data", parameters: { type: "object" } }];
    const events = await collectTrustedModelCallEvents(async () => {
      const streamResult = await wrapped(
        {} as never,
        {
          systemPrompt: "trace system",
          messages: inputMessages,
          tools,
        } as never,
      );
      await streamResult.result();
      await drain(streamResult);
    });

    const publicEvents = events.map((entry) => entry.event);
    const startedEvent = getEvent(publicEvents, 0);
    expect(startedEvent.type).toBe("model.call.started");
    expect(startedEvent.inputMessages).toBeUndefined();
    expect(startedEvent.systemPrompt).toBeUndefined();
    expect(startedEvent.toolDefinitions).toBeUndefined();
    expect(events[0]?.privateData.modelContent?.inputMessages).toEqual(inputMessages);
    expect(events[0]?.privateData.modelContent?.systemPrompt).toBe("trace system");
    expect(events[0]?.privateData.modelContent?.toolDefinitions).toEqual(tools);
    const completedEvent = getEvent(publicEvents, 1);
    expect(completedEvent.type).toBe("model.call.completed");
    expect(completedEvent.outputMessages).toBeUndefined();
    expect(events[1]?.privateData.modelContent?.inputMessages).toEqual(inputMessages);
    expect(events[1]?.privateData.modelContent?.outputMessages).toEqual([assistant]);
  });

  const baseUsage = { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, reasoningTokens: 5 };
  const privateError = "synthetic-private-error [request_id=req_error_usage]";
  const requestHash = expect.stringMatching(/^sha256:[a-f0-9]{12}$/);
  it.each([
    ["aborted", undefined, undefined, "aborted", undefined, "iterator"],
    ["error", "request timed out", undefined, "timeout", undefined, "result"],
    ["error", privateError, "ECONNRESET", "connection_reset", requestHash, "result-then-iterator"],
    ["aborted", privateError, "ECONNRESET", "aborted", requestHash, "iterator-then-result"],
  ] as const)(
    "records %s (%s/%s) as %s with hash %s via %s exactly once",
    async (stopReason, errorMessage, errorCode, failureKind, requestIdHash, consumption) => {
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "partial reply" }],
        usage: { ...baseUsage, totalTokens: 28 },
        stopReason,
        errorMessage,
        errorCode,
        timestamp: 1,
      };
      async function* stream() {
        yield { type: "error", reason: stopReason, error: assistant };
      }
      const originalStream = Object.assign(stream(), { result: async () => assistant });
      const wrapped = wrap((() => originalStream) as unknown as StreamFn);

      const entries = await collectTrustedModelCallEvents(async () => {
        const response = wrapped(
          {} as never,
          {} as never,
          {} as never,
        ) as unknown as typeof originalStream;
        if (consumption === "result" || consumption === "result-then-iterator") {
          expect(await response.result()).toBe(assistant);
        }
        if (consumption !== "result") {
          for await (const event of response) {
            expect(event.error).toBe(assistant);
            if (consumption === "iterator-then-result") {
              expect(await response.result()).toBe(assistant);
              break;
            }
          }
        }
      });

      const events = entries.map(({ event }) => event);
      expect(events.map((event) => event.type)).toEqual(["model.call.started", "model.call.error"]);
      const errorEvent = getEvent(events, 1);
      expect(errorEvent.errorCategory).toBe("Error");
      expect(errorEvent.failureKind).toBe(failureKind);
      expect(errorEvent.upstreamRequestIdHash).toEqual(requestIdHash);
      expect(errorEvent.responseStreamBytes).toBeGreaterThan(0);
      expect(errorEvent.usage).toEqual({ ...baseUsage, total: 28, promptTokens: 16 });
      expect(entries[1]?.privateData.modelContent).toBeUndefined();
      expect(JSON.stringify(entries)).not.toContain("synthetic-private-error");
      expect(JSON.stringify(entries)).not.toContain("req_error_usage");
      expect(JSON.stringify(entries)).not.toContain("partial reply");
    },
  );

  it("skips prompt stat computation when diagnostics are disabled", async () => {
    setDiagnosticsEnabledForProcess(false);
    let promptInspected = false;
    const streamContext = {
      systemPrompt: "system",
      get messages() {
        promptInspected = true;
        return [{ role: "user", content: "x", timestamp: 1 }];
      },
      get tools() {
        promptInspected = true;
        return [{ name: "lookup", description: "d", parameters: { type: "object" } }];
      },
    };
    async function* stream() {
      yield { type: "text_delta", delta: "ok" };
    }
    const wrapped = wrap((() => stream()) as unknown as StreamFn);

    await drain(
      wrapped({} as never, streamContext as never, {} as never) as AsyncIterable<unknown>,
    );

    expect(promptInspected).toBe(false);
  });
});
