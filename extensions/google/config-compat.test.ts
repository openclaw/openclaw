import { describe, expect, it } from "vitest";
import { migrateGoogleLegacyProviderConfig } from "./config-compat.js";

describe("migrateGoogleLegacyProviderConfig", () => {
  it("repairs legacy Google provider catalog schema fields and preserves SecretRefs", () => {
    const apiKey = { source: "file", provider: "filemain", id: "/google_apiKey" };
    const config = {
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            apiKey,
            models: [
              {
                id: "gemini-2.5-pro",
                input: ["text", "image", "audio", "video"],
                cost: { input: 1.25, output: 10, cacheRead: 0 },
              },
            ],
          },
        },
      },
    };

    const result = migrateGoogleLegacyProviderConfig(config as never);
    const google = result.config.models?.providers?.google;

    expect(result.changes).toEqual([
      "Updated legacy Google provider config at models.providers.google.",
    ]);
    expect(google?.api).toBe("google-generative-ai");
    expect(google?.apiKey).toBe(apiKey);
    expect(google?.models?.[0]?.input).toEqual(["text", "image"]);
    expect(google?.models?.[0]?.cost).toEqual({
      input: 1.25,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("repairs legacy Google Vertex provider blocks", () => {
    const config = {
      models: {
        providers: {
          "google-vertex": {
            baseUrl: "https://us-central1-aiplatform.googleapis.com/v1/projects/demo",
            models: [
              {
                id: "gemini-2.5-flash",
                input: ["audio"],
                cost: { input: 0, output: 0, cacheRead: 0 },
              },
            ],
          },
        },
      },
    };

    const result = migrateGoogleLegacyProviderConfig(config as never);
    const vertex = result.config.models?.providers?.["google-vertex"];

    expect(result.changes).toEqual([
      "Updated legacy Google provider config at models.providers.google-vertex.",
    ]);
    expect(vertex?.api).toBe("google-vertex");
    expect(vertex?.models?.[0]?.input).toEqual(["text"]);
    expect(vertex?.models?.[0]?.cost?.cacheWrite).toBe(0);
  });

  it("does not rewrite explicitly non-Google provider API configs", () => {
    const config = {
      models: {
        providers: {
          google: {
            api: "openai-chat",
            baseUrl: "https://example.test/v1",
            models: [
              {
                id: "custom-model",
                input: ["text", "audio"],
                cost: { input: 1, output: 1, cacheRead: 0 },
              },
            ],
          },
        },
      },
    };

    const result = migrateGoogleLegacyProviderConfig(config as never);

    expect(result.config).toBe(config);
    expect(result.changes).toEqual([]);
  });
});
