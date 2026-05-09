import { describe, expect, it } from "vitest";
import { isGooglePromptCacheEligible, resolveCacheRetention } from "./prompt-cache-retention.js";

describe("prompt cache retention", () => {
  it("passes explicit cacheRetention through for direct Google models", () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "google",
        "google-generative-ai",
        "gemini-3.1-pro-preview",
      ),
    ).toBe("long");
  });

  it("maps legacy cacheControlTtl for direct Google models", () => {
    expect(
      resolveCacheRetention(
        { cacheControlTtl: "5m" },
        "google",
        "google-generative-ai",
        "gemini-2.5-flash",
      ),
    ).toBe("short");
  });

  it("does not default cacheRetention for direct Google models without explicit config", () => {
    expect(
      resolveCacheRetention(undefined, "google", "google-generative-ai", "gemini-3.1-pro-preview"),
    ).toBeUndefined();
  });
  it("honours explicit cacheRetention for OpenRouter Anthropic models", () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "openrouter",
        "openai-completions",
        "anthropic/claude-haiku-4.5",
      ),
    ).toBe("long");
  });

  it('honours explicit cacheRetention "short" for proxy providers', () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "short" },
        "openrouter",
        "openai-completions",
        "anthropic/claude-sonnet-4.6",
      ),
    ).toBe("short");
  });

  it('honours explicit cacheRetention "none" for proxy providers', () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "none" },
        "openrouter",
        "openai-completions",
        "anthropic/claude-sonnet-4.6",
      ),
    ).toBe("none");
  });

  it("returns undefined for proxy providers without explicit config", () => {
    expect(
      resolveCacheRetention(
        undefined,
        "openrouter",
        "openai-completions",
        "anthropic/claude-sonnet-4.6",
      ),
    ).toBeUndefined();
  });
  it("ignores explicit cacheRetention for non-OpenRouter providers without cache family", () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "amazon-bedrock",
        "openai-completions",
        "some/non-anthropic-model",
      ),
    ).toBeUndefined();
  });
  it("ignores explicit cacheRetention for OpenRouter non-Anthropic models", () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "openrouter",
        "openai-completions",
        "deepseek/deepseek-r1",
      ),
    ).toBeUndefined();
  });

  it("identifies supported direct Google cache families", () => {
    expect(
      isGooglePromptCacheEligible({
        modelApi: "google-generative-ai",
        modelId: "gemini-3.1-pro-preview",
      }),
    ).toBe(true);
    expect(
      isGooglePromptCacheEligible({
        modelApi: "google-generative-ai",
        modelId: "gemini-2.5-flash",
      }),
    ).toBe(true);
    expect(
      isGooglePromptCacheEligible({
        modelApi: "google-generative-ai",
        modelId: "gemini-live-2.5-flash-preview",
      }),
    ).toBe(false);
  });
});
