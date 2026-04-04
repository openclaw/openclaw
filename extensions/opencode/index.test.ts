import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";

describe("opencode provider plugin", () => {
  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.buildReplayPolicy?.({
        provider: "opencode",
        modelApi: "openai-completions",
        modelId: "gemini-2.5-pro",
      } as never),
    ).toMatchObject({
      applyAssistantFirstOrderingFix: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
      sanitizeThoughtSignatures: {
        allowBase64Only: true,
        includeCamelCase: true,
      },
    });
  });

  it("keeps non-Gemini replay policy minimal on passthrough routes", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.buildReplayPolicy?.({
        provider: "opencode",
        modelApi: "openai-completions",
        modelId: "claude-opus-4.6",
      } as never),
    ).toMatchObject({
      applyAssistantFirstOrderingFix: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
    });
    expect(
      provider.buildReplayPolicy?.({
        provider: "opencode",
        modelApi: "openai-completions",
        modelId: "claude-opus-4.6",
      } as never),
    ).not.toHaveProperty("sanitizeThoughtSignatures");
  });
});
