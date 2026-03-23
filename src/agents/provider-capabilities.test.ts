import { describe, expect, it, vi } from "vitest";

const resolveProviderCapabilitiesWithPluginMock = vi.fn((params: { provider: string }) => {
  switch (params.provider) {
    case "anthropic":
      return {
        providerFamily: "anthropic",
        dropThinkingBlockModelHints: ["claude"],
      };
    case "openai":
      return {
        providerFamily: "openai",
      };
    case "openrouter":
      return {
        openAiCompatTurnValidation: false,
        geminiThoughtSignatureSanitization: true,
        geminiThoughtSignatureModelHints: ["gemini"],
      };
    case "openai-codex":
      return {
        providerFamily: "openai",
      };
    case "github-copilot":
      return {
        dropThinkingBlockModelHints: ["claude"],
      };
    case "kilocode":
      return {
        geminiThoughtSignatureSanitization: true,
        geminiThoughtSignatureModelHints: ["gemini"],
      };
    case "kimi":
      return {
        preserveAnthropicThinkingSignatures: false,
      };
    default:
      return undefined;
  }
});

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderCapabilitiesWithPlugin: (params: { provider: string }) =>
    resolveProviderCapabilitiesWithPluginMock(params),
}));

import {
  isAnthropicProviderFamily,
  isOpenAiProviderFamily,
  requiresOpenAiCompatibleAnthropicToolPayload,
  resolveProviderCapabilities,
  resolveTranscriptToolCallIdMode,
  shouldDropThinkingBlocksForModel,
  shouldSanitizeGeminiThoughtSignaturesForModel,
  supportsOpenAiCompatTurnValidation,
  usesMoonshotThinkingPayloadCompat,
} from "./provider-capabilities.js";

describe("resolveProviderCapabilities", () => {
  it("returns provider-owned anthropic defaults for ordinary providers", () => {
    expect(resolveProviderCapabilities("anthropic")).toEqual({
      anthropicToolSchemaMode: "native",
      anthropicToolChoiceMode: "native",
      openAiPayloadNormalizationMode: "default",
      providerFamily: "anthropic",
      preserveAnthropicThinkingSignatures: true,
      openAiCompatTurnValidation: true,
      geminiThoughtSignatureSanitization: false,
      transcriptToolCallIdMode: "default",
      transcriptToolCallIdModelHints: [],
      geminiThoughtSignatureModelHints: [],
      dropThinkingBlockModelHints: ["claude"],
    });
    expect(resolveProviderCapabilities("anthropic-vertex")).toEqual({
      anthropicToolSchemaMode: "native",
      anthropicToolChoiceMode: "native",
      openAiPayloadNormalizationMode: "default",
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
      openAiPayloadNormalizationMode: "default",
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
    expect(resolveProviderCapabilities("kimi")).toEqual(resolveProviderCapabilities("kimi-code"));
    expect(resolveProviderCapabilities("kimi-code")).toEqual({
      anthropicToolSchemaMode: "native",
      anthropicToolChoiceMode: "native",
      openAiPayloadNormalizationMode: "default",
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

  it("routes moonshot payload compatibility through the capability registry", () => {
    expect(usesMoonshotThinkingPayloadCompat("moonshot")).toBe(true);
    expect(usesMoonshotThinkingPayloadCompat("openai")).toBe(false);
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
    expect(requiresOpenAiCompatibleAnthropicToolPayload("kimi")).toBe(false);
    expect(requiresOpenAiCompatibleAnthropicToolPayload("kimi-code")).toBe(false);
    expect(requiresOpenAiCompatibleAnthropicToolPayload("anthropic")).toBe(false);
  });

  it("tracks provider families and model-specific transcript quirks in the registry", () => {
    expect(isOpenAiProviderFamily("openai")).toBe(true);
    expect(isAnthropicProviderFamily("anthropic-vertex")).toBe(true);
    expect(isAnthropicProviderFamily("amazon-bedrock")).toBe(true);
    expect(
      shouldDropThinkingBlocksForModel({
        provider: "anthropic",
        modelId: "claude-opus-4-6",
      }),
    ).toBe(true);
    expect(
      shouldDropThinkingBlocksForModel({
        provider: "anthropic-vertex",
        modelId: "claude-sonnet-4-6",
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

  it("forwards config and workspace context to plugin capability lookup", () => {
    const config = { plugins: { enabled: true } };
    const env = { OPENCLAW_HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;

    resolveProviderCapabilities("anthropic", {
      config,
      workspaceDir: "/tmp/workspace",
      env,
    });

    expect(resolveProviderCapabilitiesWithPluginMock).toHaveBeenLastCalledWith({
      provider: "anthropic",
      config,
      workspaceDir: "/tmp/workspace",
      env,
    });
  });
});
