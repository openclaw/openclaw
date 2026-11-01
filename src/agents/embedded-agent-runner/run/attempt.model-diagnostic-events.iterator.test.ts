import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { AssistantMessageEvent } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { formatModelTransportContext } from "../../../llm/model-transport-context.js";
import { resetGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";

function wrap(
  streamFn: StreamFn,
  context: Partial<Parameters<typeof wrapStreamFnWithDiagnosticModelCallEvents>[1]> = {},
) {
  return wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
    runId: "run-1",
    provider: "openai",
    model: "fixture-model",
    trace: createDiagnosticTraceContext(),
    nextCallId: () => "call-1",
    ...context,
  });
}

async function collectModelCallEvents(run: () => Promise<void>): Promise<DiagnosticEventPayload[]> {
  const events: DiagnosticEventPayload[] = [];
  const stop = onInternalDiagnosticEvent((event) => {
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

const iteratorModel = makeProviderModelFixture({
  id: "test-model",
  provider: "test-provider",
  api: "openai-responses",
  baseUrl: "https://example.invalid",
});

describe("model diagnostic iterator lifecycle", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    resetGlobalHookRunner();
  });
  afterEach(() => {
    resetDiagnosticEventsForTest();
    resetGlobalHookRunner();
  });

  it("shares unopened return and closes the acquired source without awaiting its value", async () => {
    const value = createDeferredCore<string>();
    const cleanup = createDeferredCore();
    const sourceNext = vi.fn(async () => ({ done: true as const, value: undefined }));
    const sourceReturn = vi.fn(async () => {
      await cleanup.promise;
      return { done: true as const, value: undefined };
    });
    const result = vi.fn(async () => makeAssistantMessageFixture());
    const finished = vi.fn();
    const events = await collectModelCallEvents(async () => {
      const response = await wrap(
        () => ({
          [Symbol.asyncIterator]: () => ({ next: sourceNext, return: sourceReturn }),
          result,
        }),
        { onFinished: finished },
      )(iteratorModel, { messages: [] });
      const iterator = response[Symbol.asyncIterator]();
      const returning = iterator.return!(value.promise);
      expect(iterator.return!("ignored")).toBe(returning);
      const failure = new Error("queued throw");
      let thrown = false;
      const throwing = iterator.throw!(failure).catch((error: unknown) => {
        expect(error).toBe(failure);
        thrown = true;
      });
      await yieldToEventLoop();
      expect(thrown).toBe(false);
      cleanup.resolve();
      const returned = await returning;
      await throwing;
      expect(thrown).toBe(true);
      expect(returned.done).toBe(true);
      expect(returned.value).toBe(value.promise);
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
      expect(iterator.return!("also ignored")).toBe(returning);
      value.resolve("later");
    });
    expect(sourceNext).not.toHaveBeenCalled();
    expect(sourceReturn).toHaveBeenCalledOnce();
    expect(result).not.toHaveBeenCalled();
    expect(finished).toHaveBeenCalledExactlyOnceWith("call-1");
    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
  });

  it("finishes a pending observed read before shared return in the model call context", async () => {
    const read = createDeferredCore<IteratorResult<AssistantMessageEvent>>();
    const chunk: AssistantMessageEvent = { type: "text_delta", contentIndex: 0, delta: "x" };
    const order: string[] = [];
    const record = (phase: string) => order.push(`${phase}${formatModelTransportContext()}`);
    const sourceReturn = vi.fn(async () => {
      record("cleanup");
      await Promise.resolve();
      record("cleaned");
      return { done: true as const, value: undefined };
    });
    const result = vi.fn(async () => makeAssistantMessageFixture());
    const events = await collectModelCallEvents(async () => {
      const response = await wrap(
        () => ({
          [Symbol.asyncIterator]: () => ({
            next() {
              record("read");
              return read.promise;
            },
            return: sourceReturn,
          }),
          result,
        }),
        { onOutputDelta: () => record("observe"), onFinished: () => record("finished") },
      )(iteratorModel, { messages: [] });
      const iterator = response[Symbol.asyncIterator]();
      const reading = iterator.next();
      const returning = iterator.return!("finished");
      expect(iterator.return!("ignored")).toBe(returning);
      const afterReturn = iterator.next();
      expect(sourceReturn).not.toHaveBeenCalled();
      read.resolve({ done: false, value: chunk });
      await expect(reading).resolves.toEqual({ done: false, value: chunk });
      await expect(returning).resolves.toEqual({ done: true, value: "finished" });
      await expect(afterReturn).resolves.toEqual({ done: true, value: undefined });
    });
    const context = ' sessionKey="unknown" runId="run-1" requestId="call-1" requestNumber=call-1';
    expect(order).toEqual(
      ["read", "observe", "cleanup", "cleaned", "finished"].map((phase) => `${phase}${context}`),
    );
    expect(formatModelTransportContext()).toBe("");
    expect(sourceReturn).toHaveBeenCalledOnce();
    expect(result).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
  });

  it.each(["source", "observer", "consumer-throw", "consumer-body", "unopened-throw"] as const)(
    "preserves diagnostic error identity and cleanup ownership for %s failure",
    async (failure) => {
      const error = new TypeError(`${failure} failed`);
      const chunk: AssistantMessageEvent = { type: "text_delta", contentIndex: 0, delta: "x" };
      const sourceReturn = vi.fn(async () => ({ done: true as const, value: undefined }));
      const sourceThrow = vi.fn(async () => ({ done: true as const, value: undefined }));
      const result = vi.fn(async () => makeAssistantMessageFixture());
      const finished = vi.fn();
      const events = await collectModelCallEvents(async () => {
        const response = await wrap(
          () => ({
            [Symbol.asyncIterator]: () => ({
              next: () =>
                failure === "source"
                  ? Promise.reject(error)
                  : Promise.resolve({ done: false as const, value: chunk }),
              return: sourceReturn,
              throw: sourceThrow,
            }),
            result,
          }),
          {
            onFinished: finished,
            onOutputDelta() {
              if (failure === "observer") {
                throw error;
              }
            },
          },
        )(iteratorModel, { messages: [] });
        if (failure === "consumer-body") {
          await expect(
            (async () => {
              for await (const delivered of response) {
                expect(delivered).toBe(chunk);
                throw error;
              }
            })(),
          ).rejects.toBe(error);
        } else {
          const iterator = response[Symbol.asyncIterator]();
          if (failure === "consumer-throw" || failure === "unopened-throw") {
            if (failure === "consumer-throw") {
              await iterator.next();
            }
            await expect(iterator.throw!(error)).rejects.toBe(error);
          } else {
            await expect(iterator.next()).rejects.toBe(error);
          }
          await iterator.return!();
          await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
        }
      });
      expect(sourceReturn).toHaveBeenCalledTimes(failure === "consumer-body" ? 1 : 0);
      expect(sourceThrow).not.toHaveBeenCalled();
      expect(result).not.toHaveBeenCalled();
      expect(finished).toHaveBeenCalledTimes(failure === "unopened-throw" ? 0 : 1);
      expect(events.map((event) => event.type)).toEqual([
        "model.call.started",
        ...(failure === "unopened-throw"
          ? []
          : [failure === "consumer-body" ? "model.call.completed" : "model.call.error"]),
      ]);
    },
  );
});
