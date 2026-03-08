import { describe, expect, it } from "vitest";
import {
  requiresOpenAiCompatibleAnthropicToolPayload,
  resolveProviderCapabilities,
  resolveTranscriptToolCallIdMode,
  sanitizesGeminiThoughtSignatures,
  supportsOpenAiCompatTurnValidation,
} from "./provider-capabilities.js";

describe("resolveProviderCapabilities", () => {
  it("returns native anthropic defaults for ordinary providers", () => {
    expect(resolveProviderCapabilities("anthropic")).toEqual({
      anthropicToolSchemaMode: "native",
      anthropicToolChoiceMode: "native",
      preserveAnthropicThinkingSignatures: true,
      openAiCompatTurnValidation: true,
      geminiThoughtSignatureSanitization: false,
      transcriptToolCallIdMode: "default",
    });
  });

  it("normalizes kimi aliases to the same capability set", () => {
    expect(resolveProviderCapabilities("kimi-coding")).toEqual(
      resolveProviderCapabilities("kimi-code"),
    );
    expect(resolveProviderCapabilities("kimi-code")).toEqual({
      anthropicToolSchemaMode: "openai-functions",
      anthropicToolChoiceMode: "openai-string-modes",
      preserveAnthropicThinkingSignatures: false,
      openAiCompatTurnValidation: true,
      geminiThoughtSignatureSanitization: false,
      transcriptToolCallIdMode: "default",
    });
  });

  it("flags providers that opt out of OpenAI-compatible turn validation", () => {
    expect(supportsOpenAiCompatTurnValidation("openrouter")).toBe(false);
    expect(supportsOpenAiCompatTurnValidation("opencode")).toBe(false);
    expect(supportsOpenAiCompatTurnValidation("moonshot")).toBe(true);
  });

  it("resolves transcript thought-signature and tool-call quirks through the registry", () => {
    expect(sanitizesGeminiThoughtSignatures("openrouter")).toBe(true);
    expect(sanitizesGeminiThoughtSignatures("kilocode")).toBe(true);
    expect(resolveTranscriptToolCallIdMode("mistral")).toBe("strict9");
  });

  it("treats kimi aliases as anthropic tool payload compatibility providers", () => {
    expect(requiresOpenAiCompatibleAnthropicToolPayload("kimi-coding")).toBe(true);
    expect(requiresOpenAiCompatibleAnthropicToolPayload("kimi-code")).toBe(true);
    expect(requiresOpenAiCompatibleAnthropicToolPayload("anthropic")).toBe(false);
  });
});
