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
      transcriptToolCallIdMode: "default",
      transcriptToolCallIdModelHints: [],
      geminiThoughtSignatureModelHints: [],
      dropThinkingBlockModelHints: [],
    });
  });

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
  });

  it("treats kimi aliases as native anthropic tool payload providers", () => {
    // kimi-coding uses native Anthropic tool format (input_schema)
    // Legacy compat.requiresOpenAiAnthropicToolPayload=true is ignored by the wrapper guard
    expect(requiresOpenAiCompatibleAnthropicToolPayload("kimi-coding")).toBe(false);
    expect(requiresOpenAiCompatibleAnthropicToolPayload("kimi-code")).toBe(false);
    // anthropic native does not require OpenAI-compatible payloads
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
