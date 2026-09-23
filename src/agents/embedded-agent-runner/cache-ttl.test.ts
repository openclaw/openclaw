// Cache-TTL delegation, built-in fallback, and session-marker coverage.
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

import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "./cache-ttl.js";

describe("isCacheTtlEligibleProvider", () => {
  it("forwards only the normalized identity and bounded resolved route", () => {
    providerEligibility.mockClear();
    const route = {
      baseUrl: "https://proxy.example/v1",
      supportsPromptCacheKey: false,
      headers: { "x-test-private": "not-for-provider-hooks" },
      apiKey: "synthetic-not-for-provider-hooks",
    };
    isCacheTtlEligibleProvider(" OPENAI ", " GPT-4O ", "openai-responses", route);
    expect(providerEligibility).toHaveBeenCalledExactlyOnceWith({
      provider: "openai",
      context: {
        provider: "openai",
        modelId: "gpt-4o",
        modelApi: "openai-responses",
        baseUrl: "https://proxy.example/v1",
        supportsPromptCacheKey: false,
      },
    });
  });

  it("is case-insensitive for native providers", () => {
    expect(isCacheTtlEligibleProvider("Moonshot", "Kimi-K2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("ZAI", "GLM-5")).toBe(true);
  });

  it("rejects unsupported providers and models", () => {
    expect(isCacheTtlEligibleProvider("openai", "gpt-4o")).toBe(false);
    expect(isCacheTtlEligibleProvider("openrouter", "openai/gpt-4o")).toBe(false);
  });

  it("allows direct Google Gemini cache-ttl models", () => {
    expect(
      isCacheTtlEligibleProvider("google", "gemini-3.1-pro-preview", "google-generative-ai"),
    ).toBe(true);
    expect(isCacheTtlEligibleProvider("google", "gemini-2.5-flash", "google-generative-ai")).toBe(
      true,
    );
  });

  it("rejects non-cacheable Google model families", () => {
    expect(
      isCacheTtlEligibleProvider("google", "gemini-live-2.5-flash-preview", "google-generative-ai"),
    ).toBe(false);
  });

  it("allows custom anthropic-messages providers", () => {
    expect(isCacheTtlEligibleProvider("litellm", "claude-sonnet-4-6", "anthropic-messages")).toBe(
      true,
    );
  });

  it("allows anthropic Bedrock models", () => {
    expect(
      isCacheTtlEligibleProvider(
        "amazon-bedrock",
        "us.anthropic.claude-sonnet-4-20250514-v1:0",
        "anthropic-messages",
      ),
    ).toBe(true);
  });
});

describe("readLastCacheTtlTimestamp", () => {
  it("returns the latest matching timestamp while ignoring projection metadata", () => {
    // Replay only reuses cache TTL entries scoped to the current model target;
    // stale entries for other providers must not reset pruning clocks.
    const sessionManager = {
      getEntries: () => [
        {
          type: "custom",
          customType: "openclaw.cache-ttl",
          data: {
            timestamp: 1_700_000_000_000,
            provider: "anthropic",
            modelId: "claude-sonnet-4-5",
            prunedToolResults: [{ key: "tool:old:42", mode: "hard" }],
            ambiguousToolResultBaseKeys: [],
          },
        },
        {
          type: "custom",
          customType: "openclaw.cache-ttl",
          data: {
            timestamp: 1_700_000_001_000,
            provider: "google",
            modelId: "gemini-3.1-pro-preview",
          },
        },
        {
          type: "custom",
          customType: "openclaw.cache-ttl",
          data: {
            prunedToolResults: [],
            frozenToolResults: [{ key: "tool:new:43", sourceHash: "hash" }],
          },
        },
      ],
    };

    expect(
      readLastCacheTtlTimestamp(sessionManager, {
        provider: "Anthropic",
        modelId: "Claude-Sonnet-4-5",
      }),
    ).toBe(1_700_000_000_000);
  });

  it("ignores unscoped cache-ttl entries when a context filter is requested", () => {
    const sessionManager = {
      getEntries: () => [
        {
          type: "custom",
          customType: "openclaw.cache-ttl",
          data: {
            timestamp: 1_700_000_000_000,
          },
        },
      ],
    };

    expect(
      readLastCacheTtlTimestamp(sessionManager, {
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
      }),
    ).toBeNull();
  });
});
