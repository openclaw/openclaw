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

  it("identifies modern models correctly via isModernModelRef", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    // Modern models should return true
    expect(provider.isModernModelRef?.({ provider: "opencode", modelId: "claude-opus-4-7" })).toBe(
      true,
    );
    expect(provider.isModernModelRef?.({ provider: "opencode", modelId: "gpt-5" })).toBe(true);
    expect(provider.isModernModelRef?.({ provider: "opencode", modelId: "gemini-2.5-pro" })).toBe(
      true,
    );

    // Legacy models should return false
    expect(provider.isModernModelRef?.({ provider: "opencode", modelId: "some-model-free" })).toBe(
      false,
    );
    expect(provider.isModernModelRef?.({ provider: "opencode", modelId: "alpha-glm-4.7" })).toBe(
      false,
    );
    expect(provider.isModernModelRef?.({ provider: "opencode", modelId: "minimax-m2.7" })).toBe(
      false,
    );
    expect(
      provider.isModernModelRef?.({ provider: "opencode", modelId: "minimax-m2.7-something" }),
    ).toBe(false);

    // Case insensitive checks
    expect(provider.isModernModelRef?.({ provider: "opencode", modelId: "ALPHA-GLM-4.7" })).toBe(
      false,
    );
    expect(provider.isModernModelRef?.({ provider: "opencode", modelId: "Some-Model-FREE" })).toBe(
      false,
    );
  });
});
