import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import anthropicPlugin from "./index.js";

describe("anthropic provider replay hooks", () => {
  it("owns native reasoning output mode for Claude transports", () => {
    const provider = registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "anthropic",
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      } as never),
    ).toBe("native");
  });

  it("owns replay policy for Claude transports", () => {
    const provider = registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.buildReplayPolicy?.({
        provider: "anthropic",
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      } as never),
    ).toEqual({
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      preserveSignatures: true,
      repairToolUseResultPairing: true,
      validateAnthropicTurns: true,
      allowSyntheticToolResults: true,
      dropThinkingBlocks: true,
    });
  });
});
