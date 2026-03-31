import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveProviderCapabilitiesWithPluginMock = vi.fn((params: { provider: string }) => {
  switch (params.provider) {
    case "anthropic":
      return {
        providerFamily: "anthropic",
        dropThinkingBlockModelHints: ["claude"],
      };
    case "anthropic-vertex":
      return {
        providerFamily: "anthropic",
        dropThinkingBlockModelHints: ["claude"],
      };
    case "amazon-bedrock":
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
        openAiPayloadNormalizationMode: "moonshot-thinking",
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

let isAnthropicProviderFamily: typeof import("./provider-capabilities.js").isAnthropicProviderFamily;
let isOpenAiProviderFamily: typeof import("./provider-capabilities.js").isOpenAiProviderFamily;
let requiresOpenAiCompatibleAnthropicToolPayload: typeof import("./provider-capabilities.js").requiresOpenAiCompatibleAnthropicToolPayload;
let resolveProviderCapabilities: typeof import("./provider-capabilities.js").resolveProviderCapabilities;
let resolveTranscriptToolCallIdMode: typeof import("./provider-capabilities.js").resolveTranscriptToolCallIdMode;
let shouldDropThinkingBlocksForModel: typeof import("./provider-capabilities.js").shouldDropThinkingBlocksForModel;
let shouldSanitizeGeminiThoughtSignaturesForModel: typeof import("./provider-capabilities.js").shouldSanitizeGeminiThoughtSignaturesForModel;
let supportsOpenAiCompatTurnValidation: typeof import("./provider-capabilities.js").supportsOpenAiCompatTurnValidation;
let usesMoonshotThinkingPayloadCompat: typeof import("./provider-capabilities.js").usesMoonshotThinkingPayloadCompat;
let providerCapabilityTesting: typeof import("./provider-capabilities.js").__testing;

describe("resolveProviderCapabilities", () => {
  beforeAll(async () => {
    ({
      isAnthropicProviderFamily,
      isOpenAiProviderFamily,
      requiresOpenAiCompatibleAnthropicToolPayload,
      resolveProviderCapabilities,
      resolveTranscriptToolCallIdMode,
      shouldDropThinkingBlocksForModel,
      shouldSanitizeGeminiThoughtSignaturesForModel,
      supportsOpenAiCompatTurnValidation,
      usesMoonshotThinkingPayloadCompat,
      __testing: providerCapabilityTesting,
    } = await import("./provider-capabilities.js"));
  });

  beforeEach(() => {
    resolveProviderCapabilitiesWithPluginMock.mockClear();
    providerCapabilityTesting.resetDepsForTests();
  });

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

  it("preserves built-in fallback capability hints when plugin overrides are partial", () => {
    resolveProviderCapabilitiesWithPluginMock.mockImplementationOnce(() => ({
      providerFamily: "anthropic",
    }));

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
  });

  it("normalizes kimi aliases to the same capability set", () => {
    expect(resolveProviderCapabilities("kimi")).toEqual(resolveProviderCapabilities("kimi-code"));
    expect(resolveProviderCapabilities("kimi-code")).toEqual({
      anthropicToolSchemaMode: "openai-functions",
      anthropicToolChoiceMode: "openai-string-modes",
      openAiPayloadNormalizationMode: "moonshot-thinking",
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
    expect(usesMoonshotThinkingPayloadCompat("kimi-coding")).toBe(true);
    expect(usesMoonshotThinkingPayloadCompat("openai")).toBe(false);
  });

  it("keeps the normalized kimi fallback aligned when plugin capabilities are unavailable", () => {
    resolveProviderCapabilitiesWithPluginMock.mockImplementationOnce(() => undefined);
    expect(usesMoonshotThinkingPayloadCompat("kimi-coding")).toBe(true);
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

  it("avoids false positives from naive substring matching (security)", () => {
    // Test that token-based matching prevents false positives
    // "notmistral-fake" should NOT match "mistral" hint (token split: ["notmistral", "fake"])
    // This is a security improvement over naive String.includes() matching
    expect(resolveTranscriptToolCallIdMode("openrouter", "notmistral-fake")).toBe(undefined);
    expect(resolveTranscriptToolCallIdMode("openrouter", "anti-mistral-blocker")).toBe(undefined);
  });

  it("treats kimi aliases as OpenAI-style anthropic tool payload providers", () => {
    expect(requiresOpenAiCompatibleAnthropicToolPayload("kimi")).toBe(true);
    expect(requiresOpenAiCompatibleAnthropicToolPayload("kimi-code")).toBe(true);
    expect(requiresOpenAiCompatibleAnthropicToolPayload("kimi-coding")).toBe(true);
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
    const lookup = vi.fn(() => undefined);

    providerCapabilityTesting.setResolveProviderCapabilitiesWithPluginForTest(lookup);

    resolveProviderCapabilities("anthropic", {
      config,
      workspaceDir: "/tmp/workspace",
      env,
    });

    expect(lookup).toHaveBeenLastCalledWith({
      provider: "anthropic",
      config,
      workspaceDir: "/tmp/workspace",
      env,
    });
  });
});
