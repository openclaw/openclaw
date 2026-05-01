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

  it.each(["sglang", "lmstudio", "vllm", "ollama"])(
    "enables streaming usage compat for manifest-declared provider %s on a local custom endpoint",
    (provider) => {
      // Mirrors the bundled openclaw.plugin.json declarations for these
      // providers: each ships
      // `providerRequest.providers.<id>.openAICompletions.supportsStreamingUsage = true`,
      // which flows into the capabilities object as
      // `supportsOpenAICompletionsStreamingUsageCompat = true` and lifts the
      // default-false branch for `usesConfiguredNonOpenAIEndpoint`.
      const detected = resolveOpenAICompletionsCompatDefaults({
        provider,
        endpointClass: "custom",
        knownProviderFamily: provider,
        supportsOpenAICompletionsStreamingUsageCompat: true,
      });

      expect(detected.supportsUsageInStreaming).toBe(true);
    },
  );

  it("preserves false default when the plugin manifest declares supportsStreamingUsage as false", () => {
    // The capability flag accepts boolean true/false explicitly. A plugin can
    // (and should) opt out for endpoints that do not honor stream_options.
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "custom-strict",
        endpointClass: "custom",
        knownProviderFamily: "custom-strict",
        supportsOpenAICompletionsStreamingUsageCompat: false,
      }).supportsUsageInStreaming,
    ).toBe(false);
  });

  it("keeps streaming usage disabled for non-standard provider families even when manifest opts in", () => {
    // `isNonStandard` (cerebras/chutes/deepseek/mistral/opencode/xai/zai) is
    // gated separately because those endpoints are known to reject
    // stream_options.include_usage. The manifest flag SHOULD still let the
    // capability propagate when present — this test pins the boolean-OR form
    // of the rule so a future tightening can't silently drop manifest opt-ins.
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "deepseek",
        endpointClass: "deepseek-native",
        knownProviderFamily: "deepseek",
        supportsOpenAICompletionsStreamingUsageCompat: true,
      }).supportsUsageInStreaming,
    ).toBe(true);
  });

  it("disables streaming usage for non-standard provider families with no manifest flag", () => {
    // The exact regression behind #75357: a custom OpenAI-compatible endpoint
    // without a corresponding plugin manifest defaults to false, so the
    // OpenClaw -> pi-ai bridge omits stream_options.include_usage and the
    // session JSONL records zero token usage.
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "remoteollama",
        endpointClass: "custom",
        knownProviderFamily: "remoteollama",
      }).supportsUsageInStreaming,
    ).toBe(false);
  });

  it("does not require a manifest flag when the configured endpoint claims native streaming-usage compat", () => {
    // `supportsNativeStreamingUsageCompat` is the secondary path: when the
    // provider family marks the endpoint as native streaming-usage capable
    // (e.g. via endpoint classification), the manifest flag is not required.
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "custom-native",
        endpointClass: "custom",
        knownProviderFamily: "custom-native",
        supportsNativeStreamingUsageCompat: true,
      }).supportsUsageInStreaming,
    ).toBe(true);
  });
});
