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

  it("passes explicit cacheRetention through for openai-completions providers (issue #81281)", () => {
    // Regression: openai-completions providers with prefix-caching backends
    // (oMLX, llama.cpp, etc.) configure compat.supportsPromptCacheKey: true
    // and cacheRetention: "long" but the wrapper was silently dropping the
    // user's explicit cacheRetention because the provider is neither in the
    // anthropic family nor google-eligible.
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "omlx-local",
        "openai-completions",
        "local_model",
      ),
    ).toBe("long");
    expect(
      resolveCacheRetention(
        { cacheRetention: "short" },
        "omlx-local",
        "openai-completions",
        "local_model",
      ),
    ).toBe("short");
    expect(
      resolveCacheRetention(
        { cacheRetention: "none" },
        "omlx-local",
        "openai-completions",
        "local_model",
      ),
    ).toBe("none");
  });

  it("returns undefined for openai-completions without explicit cacheRetention", () => {
    // Without an explicit user choice, openai-completions providers fall back
    // to the transport-level default ("short") rather than receiving a
    // wrapper-injected value.
    expect(
      resolveCacheRetention(undefined, "omlx-local", "openai-completions", "local_model"),
    ).toBeUndefined();
    expect(
      resolveCacheRetention({}, "omlx-local", "openai-completions", "local_model"),
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
