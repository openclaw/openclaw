import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";

describe("xai provider plugin", () => {
  it("owns replay policy for xAI OpenAI-compatible transports", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.buildReplayPolicy?.({
        provider: "xai",
        modelApi: "openai-completions",
        modelId: "grok-3",
      } as never),
    ).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
    });

    expect(
      provider.buildReplayPolicy?.({
        provider: "xai",
        modelApi: "openai-responses",
        modelId: "grok-4-fast",
      } as never),
    ).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      applyAssistantFirstOrderingFix: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
    });
  });
});
