// Coverage for prompt-cache retention resolution by provider and model API.
import { describe, expect, it } from "vitest";
import { isGooglePromptCacheEligible, resolveCacheRetention } from "./prompt-cache-retention.js";

describe("prompt cache retention", () => {
  it("forwards native ChatGPT retention", () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "openai",
        "openai-chatgpt-responses",
        "gpt-5.6-sol",
        undefined,
        "https://chatgpt.com/backend-api/codex",
      ),
    ).toBe("long");
  });

  it.each([undefined, "none"] as const)(
    "honors explicit retention %s for Anthropic-marker completions without cache keys",
    (cacheRetention) => {
      expect(
        resolveCacheRetention({ cacheRetention }, "custom", "openai-completions", "qwen-plus", {
          cacheControlFormat: "anthropic",
        }),
      ).toBe(cacheRetention);
    },
  );

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

  it("excludes Vertex and legacy Vertex google-generative-ai from AI Studio caching", () => {
    const g = "google-generative-ai";
    const m = "gemini-3.1-pro-preview";
    const ok = (provider: string, baseUrl?: string, modelId = m) =>
      isGooglePromptCacheEligible({ modelApi: g, modelId, provider, baseUrl });
    const ret = (extra: Record<string, unknown>, p: string, api: string, baseUrl?: string) =>
      resolveCacheRetention(extra, p, api, m, undefined, baseUrl);
    expect(ok("google-vertex")).toBe(false);
    expect(
      ok("google", "https://us-central1-aiplatform.googleapis.com/v1", "gemini-2.5-flash"),
    ).toBe(false);
    expect(ret({ cacheRetention: "long" }, "google-vertex", g)).toBeUndefined();
    expect(
      ret({ cacheRetention: "long" }, "google", g, "https://aiplatform.googleapis.com/v1"),
    ).toBeUndefined();
    expect(ret({ cacheControlTtl: "1h" }, "google-vertex", "google-vertex")).toBeUndefined();
  });

  it("passes explicit cacheRetention through for openai-completions providers when supportsPromptCacheKey (issue #81281)", () => {
    // Regression: prefix-caching OpenAI-compatible backends opt in with
    // supportsPromptCacheKey, so explicit user retention must pass through.
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "omlx-local",
        "openai-completions",
        "local_model",
        { supportsPromptCacheKey: true },
      ),
    ).toBe("long");
    expect(
      resolveCacheRetention(
        { cacheRetention: "short" },
        "omlx-local",
        "openai-completions",
        "local_model",
        { supportsPromptCacheKey: true },
      ),
    ).toBe("short");
    expect(
      resolveCacheRetention(
        { cacheRetention: "none" },
        "omlx-local",
        "openai-completions",
        "local_model",
        { supportsPromptCacheKey: true },
      ),
    ).toBe("none");
  });

  it("keeps undocumented cacheRetention values outside the Bedrock runtime contract", () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "standard" },
        "amazon-bedrock",
        "openai-completions",
        "us.anthropic.claude-sonnet-4-6",
      ),
    ).toBeUndefined();
  });

  it("does not honor explicit cacheRetention for openai-completions without supportsPromptCacheKey", () => {
    // Providers that route via openai-completions but do not advertise prompt
    // caching must keep retention out of outgoing payloads.
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "amazon-bedrock",
        "openai-completions",
        "amazon.nova-micro-v1:0",
      ),
    ).toBeUndefined();
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "omlx-local",
        "openai-completions",
        "local_model",
        { supportsPromptCacheKey: false },
      ),
    ).toBeUndefined();
  });

  it("returns undefined for openai-completions without explicit cacheRetention", () => {
    // Without an explicit user choice, openai-completions providers fall back
    // to the transport-level default ("short") rather than receiving a
    // wrapper-injected value.
    expect(
      resolveCacheRetention(undefined, "omlx-local", "openai-completions", "local_model", {
        supportsPromptCacheKey: true,
      }),
    ).toBeUndefined();
    expect(
      resolveCacheRetention({}, "omlx-local", "openai-completions", "local_model", {
        supportsPromptCacheKey: true,
      }),
    ).toBeUndefined();
  });

  it("does not map legacy cacheControlTtl for openai-completions prompt-cache-key providers", () => {
    // Legacy TTL aliases were Anthropic/Google semantics; OpenAI-compatible
    // completions providers need an explicit cacheRetention value before the
    // wrapper forwards retention to the transport.
    expect(
      resolveCacheRetention(
        { cacheControlTtl: "1h" },
        "omlx-local",
        "openai-completions",
        "local_model",
        { supportsPromptCacheKey: true },
      ),
    ).toBeUndefined();
    expect(
      resolveCacheRetention(
        { cacheControlTtl: "5m" },
        "omlx-local",
        "openai-completions",
        "local_model",
        { supportsPromptCacheKey: true },
      ),
    ).toBeUndefined();
  });
});
