import { describe, expect, it } from "vitest";
import { resolveProviderPluginLookupKey } from "./models-config.providers.policy.lookup.js";

describe("resolveProviderPluginLookupKey", () => {
  it("routes Google Generative AI custom providers to the google policy artifact", () => {
    expect(
      resolveProviderPluginLookupKey("google-paid", {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        api: "google-generative-ai",
        models: [],
      }),
    ).toBe("google");
  });

  it("routes model-level Google Generative AI providers to the google policy artifact", () => {
    expect(
      resolveProviderPluginLookupKey("custom-google", {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        models: [
          {
            id: "gemini-3-pro",
            name: "Gemini 3 Pro",
            api: "google-generative-ai",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1_048_576,
            maxTokens: 65_536,
          },
        ],
      }),
    ).toBe("google");
  });

  it("routes google-antigravity to the google policy artifact", () => {
    expect(
      resolveProviderPluginLookupKey("google-antigravity", {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        models: [],
      }),
    ).toBe("google");
  });

  it("routes google-vertex to the google policy artifact", () => {
    expect(
      resolveProviderPluginLookupKey("google-vertex", {
        baseUrl: "https://aiplatform.googleapis.com",
        models: [],
      }),
    ).toBe("google");
  });

  // Regression: runtime-constructed providers can surface `models` as a
  // non-array value, which previously threw
  //   `provider?.models?.some is not a function`
  // and crashed HTTP `/v1/chat/completions` (#66744).
  describe("runtime-constructed providers with non-array `models` (#66744)", () => {
    it("does not throw when provider.models is an object map", () => {
      expect(() =>
        resolveProviderPluginLookupKey("openrouter", {
          baseUrl: "https://openrouter.ai/api/v1",
          // @ts-expect-error — runtime providers sometimes surface an object map here
          models: { "some/model": { api: "openai-completions" } },
        }),
      ).not.toThrow();
    });

    it("does not throw when provider.models is undefined", () => {
      expect(() =>
        resolveProviderPluginLookupKey("openrouter", {
          baseUrl: "https://openrouter.ai/api/v1",
          // @ts-expect-error — undefined models surfaces at runtime for some plugins
          models: undefined,
        }),
      ).not.toThrow();
    });

    it("falls through to the providerKey when models is non-array and no other match", () => {
      expect(
        resolveProviderPluginLookupKey("openrouter", {
          baseUrl: "https://openrouter.ai/api/v1",
          // @ts-expect-error — see above
          models: { some: "garbage" },
        }),
      ).toBe("openrouter");
    });
  });
});
