import { describe, expect, it } from "vitest";
import {
  isAnthropicProviderFamily,
  isOpenAiProviderFamily,
  requiresOpenAiCompatibleAnthropicToolPayload,
  resolveProviderCapabilities,
  resolveTranscriptToolCallIdMode,
  shouldDropThinkingBlocksForModel,
  shouldSanitizeGeminiThoughtSignaturesForModel,
  supportsOpenAiCompatTurnValidation,
} from "./provider-capabilities.js";

describe("resolveProviderCapabilities", () => {
  it("returns native anthropic defaults for ordinary providers", () => {
    expect(resolveProviderCapabilities("anthropic")).toEqual({
      anthropicToolSchemaMode: "native",
      anthropicToolChoiceMode: "native",
      providerFamily: "anthropic",
      preserveAnthropicThinkingSignatures: true,
      openAiCompatTurnValidation: true,
      geminiThoughtSignatureSanitization: false,
      transcriptToolCallIdMode: "default",
      transcriptToolCallIdModelHints: [],
      geminiThoughtSignatureModelHints: [],
      dropThinkingBlockModelHints: [],
    });
  });

  it("normalizes kimi aliases to the same capability set", () => {
    expect(resolveProviderCapabilities("kimi-coding")).toEqual(
      resolveProviderCapabilities("kimi-code"),
    );
    expect(resolveProviderCapabilities("kimi-code")).toEqual({
      anthropicToolSchemaMode: "openai-functions",
      anthropicToolChoiceMode: "openai-string-modes",
      providerFamily: "default",
      preserveAnthropicThinkingSignatures: false,
      openAiCompatTurnValidation: true,
      geminiThoughtSignatureSanitization: false,
      transcriptToolCallIdMode: "default",
      transcriptToolCallIdModelHints: [],
      geminiThoughtSignatureModelHints: [],
      dropThinkingBlockModelHints: [],
    });
  });

  it("flags providers that opt out of OpenAI-compatible turn validation", () => {
    expect(supportsOpenAiCompatTurnValidation("openrouter")).toBe(false);
    expect(supportsOpenAiCompatTurnValidation("opencode")).toBe(false);
    expect(supportsOpenAiCompatTurnValidation("moonshot")).toBe(true);
  });

  it("resolves transcript thought-signature and tool-call quirks through the registry", () => {
    expect(
      shouldSanitizeGeminiThoughtSignaturesForModel({
        provider: "openrouter",
        modelId: "google/gemini-2.5-pro-preview",
      }),
    ).toBe(true);
    expect(
      shouldSanitizeGeminiThoughtSignaturesForModel({
        provider: "kilocode",
        modelId: "gemini-2.0-flash",
      }),
    ).toBe(true);
    expect(resolveTranscriptToolCallIdMode("mistral", "mistral-large-latest")).toBe("strict9");
  });

  it("treats kimi aliases as anthropic tool payload compatibility providers", () => {
    expect(requiresOpenAiCompatibleAnthropicToolPayload("kimi-coding")).toBe(true);
    expect(requiresOpenAiCompatibleAnthropicToolPayload("kimi-code")).toBe(true);
    expect(requiresOpenAiCompatibleAnthropicToolPayload("anthropic")).toBe(false);
  });

  it("tracks provider families and model-specific transcript quirks in the registry", () => {
    expect(isOpenAiProviderFamily("openai")).toBe(true);
    expect(isAnthropicProviderFamily("amazon-bedrock")).toBe(true);
    expect(
      shouldDropThinkingBlocksForModel({
        provider: "github-copilot",
        modelId: "claude-3.7-sonnet",
      }),
    ).toBe(true);
  });

  it("inherits dropThinkingBlocks for custom providers using anthropic-messages API", () => {
    // Custom providers like Together or Vercel AI Gateway configured with
    // api: "anthropic-messages" should inherit Anthropic's hints
    expect(
      shouldDropThinkingBlocksForModel({
        provider: "together",
        modelId: "claude-3.7-sonnet",
        modelApi: "anthropic-messages",
      }),
    ).toBe(true);

    expect(
      shouldDropThinkingBlocksForModel({
        provider: "vercel-ai-gateway",
        modelId: "claude-3.7-sonnet",
        modelApi: "anthropic-messages",
      }),
    ).toBe(true);

    // Should NOT inherit when using a different API
    expect(
      shouldDropThinkingBlocksForModel({
        provider: "together",
        modelId: "claude-3.7-sonnet",
        modelApi: "openai-completions",
      }),
    ).toBe(false);
  });
});
