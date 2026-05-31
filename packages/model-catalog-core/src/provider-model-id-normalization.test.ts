import { describe, expect, it } from "vitest";
import {
  collectManifestModelIdNormalizationPolicies,
  normalizeConfiguredProviderCatalogModelId,
  normalizeStaticProviderModelIdWithPolicies,
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
  });

  it("normalizes native Anthropic catalog refs without retaining the provider prefix", () => {
    expect(
      normalizeStaticProviderModelIdWithPolicies("anthropic", "anthropic/claude-haiku-4-5"),
    ).toBe("claude-haiku-4-5");
    expect(
      normalizeConfiguredProviderCatalogModelId("anthropic", "anthropic/claude-haiku-4-5"),
    ).toBe("claude-haiku-4-5");
  });

  it("normalizes native catalog refs without retaining remaining self prefixes", () => {
    expect(normalizeStaticProviderModelIdWithPolicies("google", "google/gemini-2.0-flash")).toBe(
      "gemini-2.0-flash",
    );
    expect(
      normalizeStaticProviderModelIdWithPolicies(
        "google-gemini-cli",
        "google-gemini-cli/gemini-2.0-flash",
      ),
    ).toBe("gemini-2.0-flash");
    expect(
      normalizeStaticProviderModelIdWithPolicies(
        "google-vertex",
        "google-vertex/gemini-3-pro-preview",
      ),
    ).toBe("gemini-3.1-pro-preview");
    expect(normalizeStaticProviderModelIdWithPolicies("xai", "xai/grok-4-fast-reasoning")).toBe(
      "grok-4-fast",
    );
    expect(normalizeStaticProviderModelIdWithPolicies("openai", "openai/gpt-5.4")).toBe("gpt-5.4");
    expect(
      normalizeStaticProviderModelIdWithPolicies("vercel-ai-gateway", "vercel-ai-gateway/opus-4.6"),
    ).toBe("anthropic/claude-opus-4-6");
  });
});
