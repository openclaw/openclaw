import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEvent,
} from "openclaw/plugin-sdk/llm";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeTranscriptJsonValue } from "../../../config/sessions/transcript-json-normalize.js";
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
import { formatModelTransportContext } from "../../../llm/model-transport-context.js";
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
import {
  createModelObserver,
  createModelPromptStats,
} from "./attempt.model-diagnostic-observation.js";

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

function completedChunks<T>(...chunks: T[]) {
  return Object.assign(
    (async function* () {
      yield* chunks;
    })(),
    {
      result: async () =>
        makeAssistantMessageFixture({ stopReason: "stop", errorMessage: undefined, content: [] }),
    },
  );
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

  it("carries the existing model call identity into asynchronous transport work", async () => {
    const observed: string[] = [];
    const source: StreamFn = async () => {
      await Promise.resolve();
      observed.push(`create${formatModelTransportContext()}`);
      return {
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < 2; index++) {
            await Promise.resolve();
            observed.push(`iterate-${index}${formatModelTransportContext()}`);
            yield { type: "text_delta", contentIndex: 0, delta: String(index) } as const;
          }
          await Promise.resolve();
          observed.push(`iterate-2${formatModelTransportContext()}`);
          yield {
            type: "done",
            reason: "stop",
            message: makeAssistantMessageFixture({ stopReason: "stop" }),
          } as const;
        },
        async result() {
          await Promise.resolve();
          observed.push(`result${formatModelTransportContext()}`);
          return makeAssistantMessageFixture({ stopReason: "stop" });
        },
      };
    };
    const model = makeProviderModelFixture({
      id: "test-model",
      provider: "test-provider",
      api: "openai-responses",
      baseUrl: "https://example.invalid",
    });
    const streams = await Promise.all(
      [1, 2].map(async (number) =>
        wrap(source, {
          runId: `run-${number}`,
          sessionKey: `session-${number}`,
          nextCallId: () => `run-${number}:model:7`,
        })(model, { messages: [] }),
      ),
    );
    const iterators = streams.map((stream) => stream[Symbol.asyncIterator]());
    for (let index = 0; index < 3; index++) {
      const values = await Promise.all(iterators.map((iterator) => iterator.next()));
      expect(values.every((value) => !value.done)).toBe(true);
      expect(formatModelTransportContext()).toBe("");
    }
    const exhausted = await Promise.all(iterators.map((iterator) => iterator.next()));
    expect(exhausted.every((value) => value.done)).toBe(true);
    await Promise.all(streams.map((stream) => stream.result()));
    expect(observed.toSorted()).toEqual(
      ["create", "iterate-0", "iterate-1", "iterate-2", "result"].flatMap((phase) => [
        `${phase} sessionKey="session-1" runId="run-1" requestId="run-1:model:7" requestNumber=7`,
        `${phase} sessionKey="session-2" runId="run-2" requestId="run-2:model:7" requestNumber=7`,
      ]),
    );
    expect(formatModelTransportContext()).toBe("");
  });

  it("observes each iterator value once without mutating a frozen provider stream", async () => {
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
    let nextReads = 0;
    let nextCalls = 0;
    const source: Awaited<ReturnType<StreamFn>> = {
      [Symbol.asyncIterator]() {
        let emitted = false;
        const iterator: AsyncIterator<AssistantMessageEvent> = {
          get next() {
            nextReads++;
            return async function (this: AsyncIterator<AssistantMessageEvent>) {
              expect(this).toBe(iterator);
              nextCalls++;
              if (emitted) {
                return { done: true as const, value: undefined };
              }
              emitted = true;
              return {
                done: false as const,
                get value() {
                  return readChunk();
                },
              };
            };
          },
        };
        return iterator;
      },
      async result() {
        return makeAssistantMessageFixture({
          content: [{ type: "text", text: "first" }],
          stopReason: "stop",
          errorMessage: undefined,
        });
      },
    };
    Object.freeze(source);
    const wrapped = wrap(() => source, {
      provider: model.provider,
      model: model.id,
    });
    const chunks: AssistantMessageEvent[] = [];
    const events = await collectModelCallEvents(async () => {
      const response = await wrapped(model, { messages: [] });
      expect(response).not.toBe(source);
      for await (const chunk of response) {
        chunks.push(chunk);
      }
      await response.result();
    });

    expect(chunks).toEqual([firstChunk]);
    expect(readChunk).toHaveBeenCalledOnce();
    expect(nextReads).toBe(1);
    expect(nextCalls).toBe(2);
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
      (() => completedChunks({ type: "text", text: "ok" })) as unknown as StreamFn,
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
      result: async () => makeAssistantMessageFixture(),
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
    const messages = [{ role: "user" as const, content: "fixture", timestamp: 0, extra: value }];
    const tools = [{ name: "fixture", description: "fixture", parameters: Type.Object({}, value) }];
    const measurePromptStats = createModelPromptStats();
    const observer = createModelObserver({
      streamContext: { messages, tools },
      capturePromptStats: true,
      captureByteStats: true,
      measurePromptStats,
    });
    observer.assignRequestPayloadBytes(value);
    observer.observeResponseChunk(Date.now(), value);

    expect(observer.promptStats?.inputMessagesChars).toBe(JSON.stringify(messages).length);
    expect(observer.promptStats?.toolDefinitionsChars).toBe(JSON.stringify(tools).length);
    expect(observer.sizeTimingFields()).toMatchObject({
      requestPayloadBytes: Buffer.byteLength(JSON.stringify(value), "utf8"),
      responseStreamBytes: Buffer.byteLength(JSON.stringify(value), "utf8"),
    });
    for (const text of ["changed 漢字\ud800".repeat(512), "short"]) {
      value.large = text;
      expect(measurePromptStats({ messages, tools })).toMatchObject({
        inputMessagesChars: JSON.stringify(messages).length,
        toolDefinitionsChars: JSON.stringify(tools).length,
      });
    }
  });

  it("matches native JSON sizes for owned, mutable, edited and compacted histories", () => {
    let seed = 7;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const alphabet = ['"', "\\", "\n", "\u0000", "漢", "🦞", "\ud800", "\udfff", "a"];
    const messages = Array.from({ length: 64 }, (_, index) => {
      const text = Array.from(
        { length: random() % 80 },
        () => alphabet[random() % alphabet.length],
      ).join("");
      const message = {
        role: "user" as const,
        content: [{ type: "text" as const, text }],
        timestamp: index,
        extra: {
          [text]: [undefined, null, Number.NaN, Infinity, -0, text],
          omitted: undefined,
          fn: () => "omitted",
          custom: { toJSON: (key: string) => ({ key, text }) },
        },
      };
      if (index % 3 === 0) {
        return normalizeTranscriptJsonValue({ message }, "") as { message: typeof message };
      }
      if (index % 3 === 1) {
        return { message: normalizeTranscriptJsonValue(message, "") as typeof message };
      }
      return { message };
    }).map(({ message }) => message);
    const measure = createModelPromptStats();
    for (const change of [
      () => {},
      // oxlint-disable-next-line unicorn/no-array-reverse -- Exercise an in-place hook reorder of the same history array.
      () => messages.reverse(),
      () => {
        messages[0] = { ...messages[0]!, content: [{ type: "text", text: "hook edit" }] };
      },
      () => {
        messages[1]!.content[0]!.text = "mutable edit";
      },
      () => messages.splice(0, 50),
    ]) {
      change();
      const expected = JSON.stringify(messages).length;
      expect(measure({ messages })?.inputMessagesChars).toBe(expected);
      expect(measure({ messages })?.inputMessagesChars).toBe(expected);
    }
  });

  it("does not serialize unchanged owned history payloads again on model calls", async () => {
    setDiagnosticsEnabledForProcess(true);
    const makeMessage = (text: string) => {
      const message = {
        role: "user" as const,
        content: [{ type: "text" as const, text }],
        timestamp: 1,
      };
      normalizeTranscriptJsonValue({ message }, "");
      return message;
    };
    const first = makeMessage("owned prefix");
    const second = makeMessage("owned append");
    const messages = [first];
    const wrapped = wrap(() => createAssistantMessageEventStream());
    const expected = [JSON.stringify(messages).length, JSON.stringify([first, second]).length];
    const nativeStringify = JSON.stringify;
    const visits: string[] = [];
    type FunctionReplacer = (this: unknown, key: string, part: unknown) => unknown;
    using stringify = vi.spyOn(JSON, "stringify");
    stringify.mockImplementation(
      (
        value: unknown,
        replacer?: FunctionReplacer | (string | number)[] | null,
        space?: string | number,
      ) => {
        if (typeof replacer !== "function") {
          return nativeStringify(value, replacer, space);
        }
        return nativeStringify(
          value,
          function (key, part: unknown) {
            if (key === "text" && typeof part === "string") {
              visits.push(part);
            }
            return replacer.call(this, key, part);
          },
          space,
        );
      },
    );

    const events = await collectModelCallEvents(async () => {
      await wrapped({} as never, { messages });
      visits.length = 0;
      await wrapped({} as never, { messages });
      expect(visits).toEqual([]);
      messages.push(second);
      await wrapped({} as never, { messages });
      expect(visits).toEqual(["owned append"]);
    });
    expect(
      events.flatMap((event) =>
        event.type === "model.call.started" ? [event.promptStats?.inputMessagesChars] : [],
      ),
    ).toEqual([expected[0], expected[0], expected[1]]);
  });

  it("reuses prompt text sizes across appends while observing rewrites and compaction", async () => {
    setDiagnosticsEnabledForProcess(true);
    const first = { role: "user" as const, content: 'prefix "漢字"\n'.repeat(512), timestamp: 1 };
    const second = { role: "user" as const, content: "append 🦞\n".repeat(512), timestamp: 2 };
    const messages = [first];
    const context = { messages, systemPrompt: "system", tools: [] };
    const wrapped = wrap(() => createAssistantMessageEventStream());
    const expected: unknown[] = [];
    const events = await collectModelCallEvents(async () => {
      for (const change of [
        () => {},
        () => messages.push(second),
        () => {
          first.content = "edited \\ \ud800".repeat(512);
        },
        () => messages.splice(0, messages.length, { ...first, content: "compacted summary" }),
        () => messages.push(second),
      ]) {
        change();
        const inputMessagesChars = JSON.stringify(messages).length;
        expected.push({
          inputMessagesCount: messages.length,
          inputMessagesChars,
          systemPromptChars: 6,
          toolDefinitionsCount: 0,
          toolDefinitionsChars: 2,
          totalChars: inputMessagesChars + 8,
        });
        using stringify = vi.spyOn(JSON, "stringify");

        await wrapped({} as never, context);
        // Unchanged prefix text must not be encoded again on an append.
        if (messages.length === 2 && messages[0] === first && first.content.startsWith("prefix")) {
          expect(stringify.mock.calls.filter(([value]) => value === first.content)).toHaveLength(0);
          expect(stringify.mock.calls.filter(([value]) => value === second.content)).toHaveLength(
            1,
          );
        }
      }
    });
    expect(
      events.flatMap((event) => (event.type === "model.call.started" ? [event.promptStats] : [])),
    ).toEqual(expected);
  });

  it("does not assemble multi-megabyte JSON strings just to measure messages", () => {
    const messages = Array.from({ length: 128 }, (_, index) => ({
      role: "user" as const,
      content: `${index}: ${'A "quoted" line.\n'.repeat(1024)}`,
      timestamp: index,
    }));
    const expectedChars = JSON.stringify(messages).length;
    const expectedBytes = Buffer.byteLength(JSON.stringify({ messages }), "utf8");
    const stringify = vi.spyOn(JSON, "stringify");
    const observer = createModelObserver({
      streamContext: { messages },
      capturePromptStats: true,
      captureByteStats: true,
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
    const chunks = ["first", "second", "third"].map((delta) => ({ type: "text_delta", delta }));
    const runProgressEvents: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((event) => {
      if (event.type === "run.progress") {
        runProgressEvents.push(event);
      }
    });
    const wrapped = wrap((() => completedChunks(...chunks)) as unknown as StreamFn, {
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
    const originalPayload = { input: "secret sk-original-secret" };
    const replacementPayload = { input: "redacted" };
    const wrapped = wrap((async (
      model: Parameters<StreamFn>[0],
      _context: Parameters<StreamFn>[1],
      options: Parameters<StreamFn>[2],
    ) => {
      await options?.onPayload?.(originalPayload, model);
      return completedChunks({ type: "text_delta", delta: "safe" });
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

  it.each(["partial snapshots", "opaque chunks"])(
    "counts stream bytes without inspecting %s",
    async (scenario) => {
      const serializedPartial = vi.fn(() => {
        throw new Error("partial snapshot should not be serialized for text deltas");
      });
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
      const opaque = scenario === "opaque chunks";
      const sourceChunks = opaque
        ? [opaqueChunk, { type: "text_delta", delta: "ok" }]
        : (
            [
              ["a", "a"],
              ["bc", "abc"],
            ] as const
          ).map(([delta, text]) => ({
            type: "text_delta",
            contentIndex: 0,
            delta,
            partial: {
              toJSON: serializedPartial,
              role: "assistant",
              content: [{ type: "text", text: text.repeat(200_000) }],
            },
          }));
      const wrapped = wrap((() => completedChunks(...sourceChunks)) as unknown as StreamFn);
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
      if (opaque) {
        expect(chunks).toHaveLength(2);
        expect(chunks[0]).toBe(opaqueChunk);
        expect(chunks[1]).toEqual({ type: "text_delta", delta: "ok" });
      }
      const completedEvent = getEvent(events, 1);
      expect(completedEvent.type).toBe("model.call.completed");
      expect(completedEvent.responseStreamBytes).toBe(
        Buffer.byteLength(opaque ? "ok" : "abc", "utf8"),
      );
      expect(serializedPartial).not.toHaveBeenCalled();
    },
  );

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

  it.each(["model.call.started", "model.call.completed", "model.call.error"] as const)(
    "preserves prompt stats for a listener interested only in %s",
    async (type) => {
      resetDiagnosticEventsForTest();
      const events: DiagnosticEventPayload[] = [];
      onTrustedInternalDiagnosticEvent((event) => events.push(event), { includeTrusted: [type] });
      const wrapped = wrap(() => {
        if (type === "model.call.error") {
          throw new Error("synthetic provider failure");
        }
        const stream = createAssistantMessageEventStream();
        stream.end(makeAssistantMessageFixture({ stopReason: "stop", errorMessage: undefined }));
        return stream;
      });
      const context = { messages: [], systemPrompt: "system" };
      if (type === "model.call.error") {
        expect(() => wrapped({} as never, context)).toThrow("synthetic provider failure");
      } else {
        await (await wrapped({} as never, context)).result();
      }
      await waitForDiagnosticEventsDrained();
      expect(events).toEqual([
        expect.objectContaining({
          type,
          promptStats: {
            inputMessagesCount: 0,
            inputMessagesChars: 2,
            systemPromptChars: 6,
            totalChars: 8,
          },
        }),
      ]);
    },
  );
});
