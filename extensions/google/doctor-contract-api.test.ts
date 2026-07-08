// Google tests cover doctor contract config compatibility.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfig } from "./doctor-contract-api.js";

function readGoogleProvider(config: OpenClawConfig): Record<string, unknown> | undefined {
  return (config.models?.providers as Record<string, unknown> | undefined)?.["google"] as
    | Record<string, unknown>
    | undefined;
}

describe("google doctor contract", () => {
  it("backfills missing api", () => {
    const config = {
      models: {
        providers: {
          google: {
            models: [
              {
                id: "gemini-2.5-flash",
                name: "Gemini 2.5 Flash",
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1048576,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.changes).toEqual([
      "Set models.providers.google.api = google-generative-ai (was missing).",
    ]);
    expect(readGoogleProvider(result.config)?.api).toBe("google-generative-ai");
    expect(readGoogleProvider(config)?.api).toBeUndefined();
  });

  it("coerces input modalities to text and image", () => {
    const config = {
      models: {
        providers: {
          google: {
            api: "google-generative-ai",
            models: [
              {
                id: "gemini-2.5-flash",
                name: "Gemini 2.5 Flash",
                input: ["text", "image", "audio", "video"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1048576,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.changes).toEqual([
      "Coerced models.providers.google.models[0].input to [text, image] (removed unsupported modalities).",
    ]);
    const models = (
      readGoogleProvider(result.config)?.models as Array<Record<string, unknown>>
    )?.[0];
    expect(models?.input).toEqual(["text", "image"]);
  });

  it("backfills missing cost.cacheWrite", () => {
    const config = {
      models: {
        providers: {
          google: {
            api: "google-generative-ai",
            models: [
              {
                id: "gemini-2.5-flash",
                name: "Gemini 2.5 Flash",
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0 },
                contextWindow: 1048576,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.changes).toEqual([
      "Added models.providers.google.models[0].cost.cacheWrite = 0 (was missing).",
    ]);
    const models = (
      readGoogleProvider(result.config)?.models as Array<Record<string, unknown>>
    )?.[0];
    expect((models?.cost as Record<string, unknown>)?.cacheWrite).toBe(0);
  });

  it("repairs all three legacy fields in one pass", () => {
    const config = {
      models: {
        providers: {
          google: {
            models: [
              {
                id: "gemini-2.5-flash",
                name: "Gemini 2.5 Flash",
                input: ["text", "image", "audio", "video"],
                cost: { input: 0, output: 0, cacheRead: 0 },
                contextWindow: 1048576,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.changes).toEqual([
      "Set models.providers.google.api = google-generative-ai (was missing).",
      "Coerced models.providers.google.models[0].input to [text, image] (removed unsupported modalities).",
      "Added models.providers.google.models[0].cost.cacheWrite = 0 (was missing).",
    ]);
    const provider = readGoogleProvider(result.config);
    expect(provider?.api).toBe("google-generative-ai");
    const models = (provider?.models as Array<Record<string, unknown>>)?.[0];
    expect(models?.input).toEqual(["text", "image"]);
    expect((models?.cost as Record<string, unknown>)?.cacheWrite).toBe(0);
  });

  it("preserves existing apiKey and baseUrl", () => {
    const config = {
      models: {
        providers: {
          google: {
            apiKey: "fake",
            baseUrl: "https://custom.example.test",
            models: [
              {
                id: "gemini-2.5-flash",
                name: "Gemini 2.5 Flash",
                input: ["text", "image", "audio", "video"],
                cost: { input: 0, output: 0, cacheRead: 0 },
                contextWindow: 1048576,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const result = normalizeCompatibilityConfig({ cfg: config });

    const provider = readGoogleProvider(result.config);
    expect(provider?.apiKey).toBe("fake");
    expect(provider?.baseUrl).toBe("https://custom.example.test");
    expect(provider?.api).toBe("google-generative-ai");
  });

  it("leaves already-valid Google config unchanged", () => {
    const config = {
      models: {
        providers: {
          google: {
            api: "google-generative-ai",
            models: [
              {
                id: "gemini-2.5-flash",
                name: "Gemini 2.5 Flash",
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1048576,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.changes).toEqual([]);
    expect(result.config).toBe(config);
  });

  it("leaves config without Google provider unchanged", () => {
    const config = {
      models: {
        providers: {
          openai: {
            api: "openai",
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.changes).toEqual([]);
  });

  it("does not mutate the input config", () => {
    const config = {
      models: {
        providers: {
          google: {
            models: [
              {
                id: "gemini-2.5-flash",
                name: "Gemini 2.5 Flash",
                input: ["text", "image", "audio", "video"],
                cost: { input: 0, output: 0, cacheRead: 0 },
                contextWindow: 1048576,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    normalizeCompatibilityConfig({ cfg: config });

    const models = (
      (config.models?.providers as Record<string, unknown>)?.google as Record<string, unknown>
    )?.models as Array<Record<string, unknown>>;
    expect(models[0]?.input).toEqual(["text", "image", "audio", "video"]);
    expect((models[0]?.cost as Record<string, unknown>)?.cacheWrite).toBeUndefined();
  });
});
