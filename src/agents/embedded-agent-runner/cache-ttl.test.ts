import { describe, expect, it, vi } from "vitest";

const providerEligibility = vi.hoisted(() => vi.fn());

vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveProviderCacheTtlEligibility: (params: { context: { provider: string } }) => {
    providerEligibility(params);
    if (params.context.provider === "moonshot" || params.context.provider === "zai") {
      return true;
    }
    if (params.context.provider === "openrouter") {
      return false;
    }
    return undefined;
  },
}));

import {
  isCacheTtlEligibleProvider as isEligible,
  readLastCacheTtlTimestamp,
} from "./cache-ttl.js";

describe("isCacheTtlEligibleProvider", () => {
  it("forwards only the normalized identity and bounded resolved route", () => {
    providerEligibility.mockClear();
    const route = {
      baseUrl: "https://proxy.example/v1",
      supportsPromptCacheKey: false,
      headers: { "x-test-private": "not-for-provider-hooks" },
      apiKey: "synthetic-not-for-provider-hooks",
    };
    expect(isEligible(" Moonshot ", " Kimi-K2.5 ", "openai-responses", route)).toBe(true);
    expect(providerEligibility).toHaveBeenCalledExactlyOnceWith({
      provider: "moonshot",
      context: {
        provider: "moonshot",
        modelId: "kimi-k2.5",
        modelApi: "openai-responses",
        baseUrl: "https://proxy.example/v1",
        supportsPromptCacheKey: false,
      },
    });
  });

  it.each([
    ["openai", "gpt-4o", undefined, undefined],
    ["openrouter", "openai/gpt-4o", undefined, undefined],
    ["openrouter", "model-1", "openai-responses", { supportsPromptCacheKey: true }],
    ["myproxy", "model-1", "custom-api", { supportsPromptCacheKey: true }],
  ] as const)("rejects unsupported %s/%s via %s", (provider, model, api, route) => {
    expect(isEligible(provider, model, api, route)).toBe(false);
  });

  it.each(["openai-responses", "openai-completions", "openai-chatgpt-responses"])(
    "requires explicit cache support for a custom %s provider",
    (modelApi) => {
      const route = { baseUrl: "https://proxy.example/v1" };
      const eligible = (supportsPromptCacheKey?: boolean) =>
        isEligible("myproxy", "model-1", modelApi, {
          ...route,
          supportsPromptCacheKey,
        });
      expect(eligible(true)).toBe(true);
      expect(eligible(false)).toBe(false);
      expect(isEligible("myproxy", "model-1", modelApi, route)).toBe(false);
    },
  );

  it("allows custom anthropic-messages providers", () => {
    expect(isEligible("litellm", "claude-sonnet-4-6", "anthropic-messages")).toBe(true);
  });
});

describe("readLastCacheTtlTimestamp", () => {
  const target = { provider: "Anthropic", modelId: "Claude-Sonnet-4-5" };
  const marker = (data: Record<string, unknown>) => ({
    type: "custom",
    customType: "openclaw.cache-ttl",
    data,
  });
  it("returns the latest matching timestamp while ignoring projection metadata", () => {
    const sessionManager = {
      getEntries: () => [
        marker({
          timestamp: 1_700_000_000_000,
          provider: "anthropic",
          modelId: "claude-sonnet-4-5",
          prunedToolResults: [{ key: "tool:old:42", mode: "hard" }],
          ambiguousToolResultBaseKeys: [],
        }),
        marker({
          timestamp: 1_700_000_001_000,
          provider: "google",
          modelId: "gemini-3.1-pro-preview",
        }),
        marker({
          prunedToolResults: [],
          frozenToolResults: [{ key: "tool:new:43", sourceHash: "hash" }],
        }),
      ],
    };

    expect(readLastCacheTtlTimestamp(sessionManager, target)).toBe(1_700_000_000_000);
  });

  it("ignores unscoped cache-ttl entries when a context filter is requested", () => {
    expect(
      readLastCacheTtlTimestamp(
        { getEntries: () => [marker({ timestamp: 1_700_000_000_000 })] },
        target,
      ),
    ).toBeNull();
  });
});
