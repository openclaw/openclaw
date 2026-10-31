// Coverage for converting sensitive/unhandled stop reasons into assistant errors.
import { createHook } from "node:async_hooks";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { AssistantMessageEvent, Context, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { createQueuedAssistantStream } from "../../test-helpers/assistant-event-stream.test-support.js";
import { wrapStreamFnHandleSensitiveStopReason } from "./attempt-stop-reason-recovery.js";

const anthropicModel = {
  api: "anthropic-messages",
  provider: "anthropic",
  id: "claude-sonnet-4-6",
} as Model<"anthropic-messages">;

describe("wrapStreamFnHandleSensitiveStopReason", () => {
  // Bun does not emit PROMISE init hooks; this budget covers the Node Gateway runtime.
  it.runIf(!process.versions.bun)(
    "adds only one Node promise per ordinary iterator read",
    async () => {
      const event: AssistantMessageEvent = {
        type: "text_delta",
        contentIndex: 0,
        delta: "chunk",
      };
      const result = { done: false as const, value: event };
      const source: Awaited<ReturnType<StreamFn>> = {
        [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve(result) }),
        result: async () => makeAgentAssistantMessage({ content: [] }),
      };
      const stream = await wrapStreamFnHandleSensitiveStopReason(() => source)(anthropicModel, {
        messages: [],
      });
      const iterator = stream[Symbol.asyncIterator]();
      let promises = 0;
      const hook = createHook({
        init(_id, type) {
          if (type === "PROMISE") {
            promises++;
          }
        },
      });
      for (let index = 0; index < 16; index++) {
        let pending: ReturnType<typeof iterator.next>;
        hook.enable();
        try {
          pending = iterator.next();
        } finally {
          hook.disable();
        }
        expect(await pending).toBe(result);
      }
      // One source promise and one normalization continuation per read.
      expect(promises).toBe(32);
    },
  );

  it.each(["throw", "reject", "patch"] as const)(
    "normalizes %s failures once and preserves unrelated errors",
    async (mode) => {
      for (const recognized of [true, false]) {
        const failure = new Error(
          recognized ? "Unhandled stop reason: sensitive" : "provider failed",
        );
        const message = makeAgentAssistantMessage({ content: [] });
        if (mode === "patch") {
          Object.defineProperty(message, "errorMessage", {
            get: () => {
              throw failure;
            },
          });
        }
        const next = vi.fn(() => {
          if (mode === "throw") {
            throw failure;
          }
          return mode === "reject"
            ? Promise.reject(failure)
            : Promise.resolve({
                done: false as const,
                value: { type: "error" as const, reason: "error" as const, error: message },
              });
        });
        const source: Awaited<ReturnType<StreamFn>> = {
          [Symbol.asyncIterator]: () => ({ next }),
          result: async () => message,
        };
        const stream = await wrapStreamFnHandleSensitiveStopReason(() => source)(anthropicModel, {
          messages: [],
        });
        const iterator = stream[Symbol.asyncIterator]();
        const pending = iterator.next();
        const overlapping = recognized && mode === "throw" ? iterator.next() : undefined;
        if (!recognized) {
          await expect(pending).rejects.toBe(failure);
          continue;
        }
        expect(await pending).toMatchObject({
          done: false,
          value: {
            type: "error",
            reason: "error",
            error: {
              errorMessage:
                "The model stopped because the provider returned an unhandled stop reason: sensitive. Please rephrase and try again.",
            },
          },
        });
        expect(await (overlapping ?? iterator.next())).toEqual({ done: true, value: undefined });
        expect(next).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("preserves cancellation and consumer errors after an ordinary chunk", async () => {
    const message = makeAgentAssistantMessage({ content: [] });
    const onReturn = vi.fn(async () => ({ done: true as const, value: undefined }));
    const onThrow = vi.fn(async () => ({ done: true as const, value: undefined }));
    const source: Awaited<ReturnType<StreamFn>> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: { type: "start", partial: message } }),
        return: onReturn,
        throw: onThrow,
      }),
      result: async () => message,
    };
    const stream = await wrapStreamFnHandleSensitiveStopReason(() => source)(anthropicModel, {
      messages: [],
    });
    const iterator = stream[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({ value: { type: "start" } });
    await iterator.return?.("cancelled");
    const failure = new Error("consumer failed");
    await iterator.throw?.(failure);
    expect(onReturn).toHaveBeenCalledExactlyOnceWith("cancelled");
    expect(onThrow).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it.each([
    { mode: "stream", stopReason: "sensitive" },
    { mode: "throw", stopReason: "refusal_policy" },
  ])("converts $mode errors with stop reason $stopReason", async ({ mode, stopReason }) => {
    const baseStreamFn: StreamFn = () => {
      const errorMessage = `Unhandled stop reason: ${stopReason}`;
      if (mode === "throw") {
        throw new Error(errorMessage);
      }
      return createQueuedAssistantStream((push) => {
        push({
          type: "error",
          reason: "error",
          error: makeAgentAssistantMessage({
            content: [],
            api: anthropicModel.api,
            provider: anthropicModel.provider,
            model: anthropicModel.id,
            stopReason: "error",
            errorMessage,
            timestamp: Date.now(),
          }),
        });
      });
    };
    const wrapped = wrapStreamFnHandleSensitiveStopReason(baseStreamFn);
    const stream = await Promise.resolve(
      wrapped(anthropicModel, { messages: [] } as Context, undefined),
    );
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(
      `The model stopped because the provider returned an unhandled stop reason: ${stopReason}. Please rephrase and try again.`,
    );
  });
});
