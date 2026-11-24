import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDiagnosticEventsForTest } from "../../../infra/diagnostic-events.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import {
  getModelTransportContext,
  withModelTransportContext,
} from "../../../llm/model-transport-context.js";
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

afterEach(() => resetDiagnosticEventsForTest());

describe("model stream transport context", () => {
  it.each(["return", "throw"] as const)(
    "keeps interleaved iterator context across awaits and %s without changing the caller",
    async (close) => {
      const callerContext = new AsyncLocalStorage<{ requestId: string }>();
      const seen: string[] = [];
      const record = (phase: string) =>
        seen.push(
          `${phase}:${getModelTransportContext()?.requestId}:${callerContext.getStore()?.requestId}`,
        );
      const sourceReturn = vi.fn(async () => {
        record("return");
        await nextTurn();
        record("returned");
        return { done: true as const, value: undefined };
      });
      const sourceThrow = vi.fn();
      const iterators = await Promise.all(
        ["first", "second"].map(async (callId) => {
          const response = await wrap(
            () => ({
              [Symbol.asyncIterator]: () => ({
                async next() {
                  record("next");
                  await nextTurn();
                  record("awaited");
                  return {
                    done: false as const,
                    value: { type: "text_delta" as const, contentIndex: 0, delta: "x" },
                  };
                },
                return: sourceReturn,
                throw: sourceThrow,
              }),
              result: async () => makeAssistantMessageFixture(),
            }),
            { nextCallId: () => callId, onFinished: () => record("finished") },
          )(
            makeProviderModelFixture({
              id: "fixture-model",
              provider: "openai",
              api: "openai-responses",
              baseUrl: "https://example.invalid",
            }),
            { messages: [] },
          );
          return response[Symbol.asyncIterator]();
        }),
      );
      const expected: string[] = [];
      for (let chunk = 0; chunk < 3; chunk++) {
        for (const [index, iterator] of iterators.entries()) {
          const caller = { requestId: `caller-${chunk}-${index}` };
          await callerContext.run(caller, () =>
            withModelTransportContext(caller, async () => {
              const reading = iterator.next();
              expect(getModelTransportContext()).toBe(caller);
              await reading;
              expect(getModelTransportContext()).toBe(caller);
            }),
          );
          const callId = index === 0 ? "first" : "second";
          expected.push(
            `next:${callId}:${caller.requestId}`,
            `awaited:${callId}:${caller.requestId}`,
          );
        }
      }
      for (const [index, iterator] of iterators.entries()) {
        const caller = { requestId: "closing-caller" };
        const callId = index === 0 ? "first" : "second";
        await callerContext.run(caller, () =>
          withModelTransportContext(caller, async () => {
            if (close === "return") {
              await iterator.return!();
              expected.push(
                `return:${callId}:${caller.requestId}`,
                `returned:${callId}:${caller.requestId}`,
              );
            } else {
              const error = new Error("consumer stopped");
              await expect(iterator.throw!(error)).rejects.toBe(error);
            }
            expect(getModelTransportContext()).toBe(caller);
          }),
        );
        expected.push(`finished:${callId}:${caller.requestId}`);
      }
      expect(seen).toEqual(expected);
      expect(sourceReturn).toHaveBeenCalledTimes(close === "return" ? 2 : 0);
      // Diagnostic throws deliberately leave cleanup with the provider.
      expect(sourceThrow).not.toHaveBeenCalled();
      expect(getModelTransportContext()).toBeUndefined();
      expect(callerContext.getStore()).toBeUndefined();
    },
  );
});
