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
      transcriptToolCallIdMode: undefined,
      transcriptToolCallIdModelHints: [],
      geminiThoughtSignatureModelHints: [],
      dropThinkingBlockModelHints: ["claude"],
    });
    expect(resolveProviderCapabilities("amazon-bedrock")).toEqual({
      anthropicToolSchemaMode: "native",
      anthropicToolChoiceMode: "native",
      providerFamily: "anthropic",
      preserveAnthropicThinkingSignatures: true,
      openAiCompatTurnValidation: true,
      geminiThoughtSignatureSanitization: false,
      transcriptToolCallIdMode: "default",
      transcriptToolCallIdModelHints: [],
      geminiThoughtSignatureModelHints: [],
      dropThinkingBlockModelHints: ["claude"],
    });
  });

  it("normalizes kimi aliases to the same capability set", () => {
    expect(resolveProviderCapabilities("kimi-coding")).toEqual(
      resolveProviderCapabilities("kimi-code"),
    );
    expect(resolveProviderCapabilities("kimi-code")).toEqual({
      anthropicToolSchemaMode: "native",
      anthropicToolChoiceMode: "native",
      providerFamily: "default",
      preserveAnthropicThinkingSignatures: false,
      openAiCompatTurnValidation: true,
      geminiThoughtSignatureSanitization: false,
      transcriptToolCallIdMode: undefined,
      transcriptToolCallIdModelHints: [],
      geminiThoughtSignatureModelHints: [],
      dropThinkingBlockModelHints: [],
    });
  });

  it.each([
    ["anthropic", "claude-opus-4-5"],
    ["amazon-bedrock", "us.anthropic.claude-opus-4-6-v1"],
    ["kimi-coding", "k2p5"],
    ["minimax", "MiniMax-M2.5"],
    ["minimax-portal", "MiniMax-M2.5"],
    ["xiaomi", "MiMo-VL-2B"],
    ["synthetic", "sonnet-4"],
  ])(
    "does not opt native Anthropic route %s into transcript tool id rewriting",
    (provider, modelId) => {
      expect(resolveTranscriptToolCallIdMode(provider, modelId)).toBeUndefined();
    },
  );

  it("flags providers that opt out of OpenAI-compatible turn validation", () => {
    expect(supportsOpenAiCompatTurnValidation("openrouter")).toBe(false);
    expect(supportsOpenAiCompatTurnValidation("opencode")).toBe(false);
    expect(supportsOpenAiCompatTurnValidation("opencode-go")).toBe(false);
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
    expect(
      shouldSanitizeGeminiThoughtSignaturesForModel({
        provider: "opencode-go",
        modelId: "google/gemini-2.5-pro-preview",
      }),
    ).toBe(true);
    expect(resolveTranscriptToolCallIdMode("mistral", "mistral-large-latest")).toBe("strict9");
    expect(resolveTranscriptToolCallIdMode("openrouter", "mistralai/devstral-2512:free")).toBe(
      "strict9",
    );
    expect(resolveTranscriptToolCallIdMode("openrouter", "openai/gpt-4o")).toBeUndefined();
  });

  it("treats kimi aliases as native anthropic tool payload providers", () => {
    expect(requiresOpenAiCompatibleAnthropicToolPayload("kimi-coding")).toBe(false);
    expect(requiresOpenAiCompatibleAnthropicToolPayload("kimi-code")).toBe(false);
    expect(requiresOpenAiCompatibleAnthropicToolPayload("anthropic")).toBe(false);
  });

  it("tracks provider families and model-specific transcript quirks in the registry", () => {
    expect(isOpenAiProviderFamily("openai")).toBe(true);
    expect(isAnthropicProviderFamily("amazon-bedrock")).toBe(true);
    expect(
      shouldDropThinkingBlocksForModel({
        provider: "anthropic",
        modelId: "claude-opus-4-6",
      }),
    ).toBe(true);
    expect(
      shouldDropThinkingBlocksForModel({
        provider: "amazon-bedrock",
        modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      }),
    ).toBe(true);
    expect(
      shouldDropThinkingBlocksForModel({
        provider: "github-copilot",
        modelId: "claude-3.7-sonnet",
      }),
    ).toBe(true);
  });
});
