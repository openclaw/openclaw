// Coverage for converting sensitive/unhandled stop reasons into assistant errors.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import { wrapStreamFnHandleSensitiveStopReason } from "./attempt-stop-reason-recovery.js";

const anthropicModel = {
  api: "anthropic-messages",
  provider: "anthropic",
  id: "claude-sonnet-4-6",
} as Model<"anthropic-messages">;

describe("wrapStreamFnHandleSensitiveStopReason", () => {
  it.each([
    { mode: "stream", stopReason: "sensitive" },
    { mode: "throw", stopReason: "refusal_policy" },
  ])("converts $mode errors with stop reason $stopReason", async ({ mode, stopReason }) => {
    const baseStreamFn: StreamFn = () => {
      const errorMessage = `Unhandled stop reason: ${stopReason}`;
      if (mode === "throw") {
        throw new Error(errorMessage);
      }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            api: anthropicModel.api,
            provider: anthropicModel.provider,
            model: anthropicModel.id,
            usage: createZeroUsageFixture(),
            stopReason: "error",
            errorMessage,
            timestamp: Date.now(),
          },
        });
        stream.end();
      });
      return stream;
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
