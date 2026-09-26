import { describe, expect, it } from "vitest";
import {
  collectManifestModelIdNormalizationPolicies,
  normalizeConfiguredProviderCatalogModelId,
  normalizeStaticProviderModelIdWithPolicies,
  stripSelfProviderModelPrefix,
} from "./provider-model-id-normalization.js";

describe("provider model id policy normalization", () => {
  it("applies manifest policies before built-in provider normalization", () => {
    const policies = collectManifestModelIdNormalizationPolicies([
      {
        modelIdNormalization: {
          providers: {
            "Google-Vertex": {
              aliases: {
                pro: "gemini-3-pro",
              },
            },
          },
        },
      },
    ]);

    expect(normalizeStaticProviderModelIdWithPolicies("google-vertex", "pro", policies)).toBe(
      "gemini-3.1-pro-preview",
    );
  });

  it("normalizes provider-prefixed Google catalog refs behind gateway prefixes", () => {
    expect(
      normalizeConfiguredProviderCatalogModelId(
        "openrouter",
        "openrouter/google/gemini-3-pro-preview",
      ),
    ).toBe("openrouter/google/gemini-3.1-pro-preview");
    expect(
      normalizeConfiguredProviderCatalogModelId("openrouter", "openrouter/google/gemma-4-26b"),
    ).toBe("openrouter/google/gemma-4-26b-a4b-it");
  });

  it("normalizes native Anthropic catalog refs without retaining the provider prefix", () => {
    expect(
      normalizeStaticProviderModelIdWithPolicies("anthropic", "anthropic/claude-haiku-4-5"),
    ).toBe("claude-haiku-4-5");
    expect(
      normalizeConfiguredProviderCatalogModelId("anthropic", "anthropic/claude-haiku-4-5"),
    ).toBe("claude-haiku-4-5");
    // Bare aliases follow family defaults; versioned aliases remain pinned.
    for (const [alias, model] of Object.entries({
      opus: "claude-opus-5-5",
      "opus-5.5": "claude-opus-5-5",
      "opus-5-5": "claude-opus-5-5",
      "anthropic/opus": "claude-opus-5-5",
      "claude-opus-5": "claude-opus-5",
      "opus-5": "claude-opus-5",
      "opus-4.8": "claude-opus-4-8",
      sonnet: "claude-sonnet-5",
      "sonnet-5": "claude-sonnet-5",
      fable: "claude-fable-5-1",
      "fable-5": "claude-fable-5",
      "fable-5.1": "claude-fable-5-1",
      haiku: "claude-haiku-4-5",
      "opus-4.7": "claude-opus-4-7",
      "mythos-5": "claude-mythos-5",
    })) {
      expect(normalizeStaticProviderModelIdWithPolicies("anthropic", alias)).toBe(model);
    }
    expect(normalizeStaticProviderModelIdWithPolicies("vercel-ai-gateway", "sonnet")).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect(normalizeStaticProviderModelIdWithPolicies("vercel-ai-gateway", "sonnet-5")).toBe(
      "anthropic/claude-sonnet-5",
    );
  });

  it("normalizes provider-prefixed native catalog refs without stripping catalog prefixes", () => {
    expect(normalizeStaticProviderModelIdWithPolicies("google", "google/gemini-2.0-flash")).toBe(
      "google/gemini-2.0-flash",
    );
    expect(
      normalizeStaticProviderModelIdWithPolicies(
        "google-gemini-cli",
        "google-gemini-cli/gemini-2.0-flash",
      ),
    ).toBe("google-gemini-cli/gemini-2.0-flash");
    expect(
      normalizeStaticProviderModelIdWithPolicies(
        "google-vertex",
        "google-vertex/gemini-3-pro-preview",
      ),
    ).toBe("google-vertex/gemini-3-pro-preview");
    expect(normalizeStaticProviderModelIdWithPolicies("xai", "xai/grok-4-fast-reasoning")).toBe(
      "xai/grok-4-fast-reasoning",
    );
    expect(normalizeStaticProviderModelIdWithPolicies("openai", "openai/gpt-5.4")).toBe(
      "openai/gpt-5.4",
    );
    expect(
      normalizeStaticProviderModelIdWithPolicies("vercel-ai-gateway", "vercel-ai-gateway/opus-4.6"),
    ).toBe("vercel-ai-gateway/opus-4.6");
  });

  it("preserves provider-owned xAI Grok 4.20 aliases", () => {
    expect(
      normalizeStaticProviderModelIdWithPolicies("xai", "grok-4.20-beta-latest-reasoning"),
    ).toBe("grok-4.20-beta-latest-reasoning");
    expect(
      normalizeStaticProviderModelIdWithPolicies(
        "xai",
        "grok-4.20-experimental-beta-0304-non-reasoning",
      ),
    ).toBe("grok-4.20-experimental-beta-0304-non-reasoning");
  });

  it("preserves the global xAI flagship alias without manifest metadata", () => {
    expect(normalizeStaticProviderModelIdWithPolicies("xai", "grok-latest")).toBe("grok-latest");
    expect(normalizeStaticProviderModelIdWithPolicies("xai", "grok-4.5-latest")).toBe("grok-4.5");
  });

  it("strips self provider model prefixes before runtime provider calls", () => {
    expect(stripSelfProviderModelPrefix("google", "google/gemini-2.0-flash")).toBe(
      "gemini-2.0-flash",
    );
  });
});

describe("manifest stripPrefixes matches and slices on the same normalized value", () => {
  function stripWith(stripPrefixes: string[], modelId: string): string {
    const policies = collectManifestModelIdNormalizationPolicies([
      {
        modelIdNormalization: {
          providers: {
            openai: { stripPrefixes },
          },
        },
      },
    ]);
    return normalizeStaticProviderModelIdWithPolicies("openai", modelId, policies);
  }

  it("strips by the matched length when the manifest prefix differs in case and spacing", () => {
    expect(stripWith([" OpenAI/ "], "openai/gpt-4")).toBe("gpt-4");
  });
});
