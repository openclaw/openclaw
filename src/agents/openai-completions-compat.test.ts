// Verifies OpenAI-compatible endpoint defaults for streaming usage and reasoning payloads.
import { describe, expect, it } from "vitest";
import {
  detectOpenAICompletionsCompat,
  resolveOpenAICompletionsCompatDefaults,
} from "./openai-completions-compat.js";

describe("resolveOpenAICompletionsCompatDefaults", () => {
  it("keeps streaming usage enabled for provider-declared compatible endpoints", () => {
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "custom-local",
        endpointClass: "local",
        knownProviderFamily: "custom-local",
        supportsNativeStreamingUsageCompat: true,
      }).supportsUsageInStreaming,
    ).toBe(true);
  });

  it("keeps streaming usage enabled for custom provider-declared compatible endpoints", () => {
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "custom-local",
        endpointClass: "custom",
        knownProviderFamily: "custom-local",
        supportsNativeStreamingUsageCompat: true,
      }).supportsUsageInStreaming,
    ).toBe(true);
  });

  it("keeps streaming usage enabled for local OpenAI-compatible endpoints", () => {
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "llama-cpp",
        endpointClass: "local",
        knownProviderFamily: "llama-cpp",
      }).supportsUsageInStreaming,
    ).toBe(true);
  });

  it("does not broaden streaming usage for generic custom providers", () => {
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "custom-cpa",
        endpointClass: "custom",
        knownProviderFamily: "custom-cpa",
      }).supportsUsageInStreaming,
    ).toBe(false);
  });

  it.each(["vllm", "sglang", "lmstudio"])(
    "enables streaming usage compat for manifest-declared local provider %s",
    (provider) => {
      // Manifest capability, not provider id alone, enables local streaming usage compat.
      expect(
        resolveOpenAICompletionsCompatDefaults({
          provider,
          endpointClass: "custom",
          knownProviderFamily: provider,
          supportsOpenAICompletionsStreamingUsageCompat: true,
        }).supportsUsageInStreaming,
      ).toBe(true);
    },
  );

  it("does not infer local streaming usage from provider id alone", () => {
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "vllm",
        endpointClass: "custom",
        knownProviderFamily: "vllm",
      }).supportsUsageInStreaming,
    ).toBe(false);
  });

  it("uses Together reasoning payload format for Together-family providers", () => {
    const defaults = resolveOpenAICompletionsCompatDefaults({
      provider: "together",
      endpointClass: "custom",
      knownProviderFamily: "together",
    });

    expect(defaults.thinkingFormat).toBe("together");
    expect(defaults.supportsReasoningEffort).toBe(false);
    expect(defaults.maxTokensField).toBe("max_tokens");
  });

  it("requires a non-empty user or assistant turn for ModelStudio-compatible providers", () => {
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "qwen",
        endpointClass: "modelstudio-native",
        knownProviderFamily: "modelstudio",
      }).requiresNonEmptyUserOrAssistantMessage,
    ).toBe(true);
  });

  it("does not require a non-empty user or assistant turn for generic local endpoints", () => {
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "vllm",
        endpointClass: "local",
        knownProviderFamily: "vllm",
      }).requiresNonEmptyUserOrAssistantMessage,
    ).toBe(false);
  });
});

describe("detectOpenAICompletionsCompat", () => {
  it("enables streaming usage compat for vLLM on a local OpenAI-compatible endpoint", () => {
    const detected = detectOpenAICompletionsCompat({
      provider: "vllm",
      baseUrl: "http://127.0.0.1:8000/v1",
      id: "Qwen/Qwen3-Coder-Next-FP8",
    });

    expect(detected.defaults.supportsUsageInStreaming).toBe(true);
  });

  it.each([
    ["provider id", "azure-openai", "https://proxy.example.com/openai/v1"],
    ["traditional host", "custom-azure", "https://example.openai.azure.com/openai/v1"],
    [
      "cognitive services host",
      "custom-azure",
      "https://example.cognitiveservices.azure.com/openai/v1",
    ],
    [
      "Foundry project host",
      "custom-azure",
      "https://example.services.ai.azure.com/api/projects/demo/openai/v1",
    ],
    [
      "regional Foundry host",
      "custom-azure",
      "https://westus.api.cognitive.microsoft.com/openai/v1",
    ],
  ])(
    "enables prompt cache keys for Azure OpenAI chat completions by %s",
    (_label, provider, baseUrl) => {
      const detected = detectOpenAICompletionsCompat({
        provider,
        baseUrl,
        id: "gpt-5.5",
      });

      expect(detected.defaults.supportsPromptCacheKey).toBe(true);
      expect(detected.defaults.supportsLongCacheRetention).toBe(true);
    },
  );
});

describe("xiaomi compat detection", () => {
  it("sets thinkingFormat to deepseek for xiaomi-native endpoint", () => {
    // Xiaomi's OpenAI-compatible route uses DeepSeek-style reasoning payloads.
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "xiaomi",
        endpointClass: "xiaomi-native",
        knownProviderFamily: "xiaomi",
      }).thinkingFormat,
    ).toBe("deepseek");
  });

  it("sets requiresReasoningContentOnAssistantMessages for xiaomi-native endpoint", () => {
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "xiaomi",
        endpointClass: "xiaomi-native",
        knownProviderFamily: "xiaomi",
      }).requiresReasoningContentOnAssistantMessages,
    ).toBe(true);
  });

  it("sets thinkingFormat to deepseek for default-route xiaomi provider", () => {
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "xiaomi",
        endpointClass: "default",
        knownProviderFamily: "xiaomi",
      }).thinkingFormat,
    ).toBe("deepseek");
  });

  it("sets requiresReasoningContentOnAssistantMessages for default-route xiaomi provider", () => {
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "xiaomi",
        endpointClass: "default",
        knownProviderFamily: "xiaomi",
      }).requiresReasoningContentOnAssistantMessages,
    ).toBe(true);
  });

  it("does not set requiresReasoningContentOnAssistantMessages for unrelated custom provider", () => {
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "other-provider",
        endpointClass: "custom",
        knownProviderFamily: "other-provider",
      }).requiresReasoningContentOnAssistantMessages,
    ).toBe(false);
  });
});
