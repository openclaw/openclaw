// Request-shape 400s that only name a thinking parameter must not trigger the
// thinking-block recovery retry.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessages } from "../test-helpers/agent-message-fixtures.js";
import { wrapAnthropicStreamWithRecovery } from "./thinking.js";

const genericizedProviderError =
  "LLM request failed: provider rejected the request schema or tool payload.";
const unsupportedThinkingParamMessage =
  '"thinking.type.disabled" is not supported for this model. Use "thinking.type.between_tools" for the lowest thinking setting, or "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.';

function thinkingHistory(): AgentMessage[] {
  return castAgentMessages([
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "secret", thinkingSignature: "sig" }],
    },
  ]);
}

describe("wrapAnthropicStreamWithRecovery request-shape errors", () => {
  it.each([
    {
      name: "rawError",
      detail: {
        rawError: `HTTP 400: ${JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: unsupportedThinkingParamMessage },
        })}`,
      },
    },
    {
      name: "errorBody",
      detail: {
        errorBody: JSON.stringify({
          error: { message: unsupportedThinkingParamMessage, type: "invalid_request_error" },
        }),
      },
    },
  ])(
    "does not retry request-shape errors naming a thinking parameter in $name",
    async ({ detail }) => {
      const providerError = Object.assign(new Error(genericizedProviderError), detail);
      let callCount = 0;
      const wrapped = wrapAnthropicStreamWithRecovery(
        (() => {
          callCount += 1;
          return Promise.reject(providerError);
        }) as Parameters<typeof wrapAnthropicStreamWithRecovery>[0],
        { id: "test-session" },
      );

      await expect(
        wrapped({} as never, { messages: thinkingHistory() } as never, {} as never),
      ).rejects.toBe(providerError);
      expect(callCount).toBe(1);
    },
  );
});
