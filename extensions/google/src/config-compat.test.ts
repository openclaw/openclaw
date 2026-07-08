// Google config compat tests cover legacy provider block migration.
import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfig } from "./config-compat.js";

describe("google config compat", () => {
  it("sets missing api to google-generative-ai for google provider", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              models: [
                {
                  id: "gemini-2.5-pro",
                  name: "Gemini 2.5 Pro",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1_048_576,
                  maxTokens: 65_536,
                },
              ],
            },
          },
        },
      },
    });

    expect(result.changes).toEqual(['Set models.providers.google.api to "google-generative-ai".']);
    expect(result.config).toEqual({
      models: {
        providers: {
          google: {
            api: "google-generative-ai",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            models: [
              {
                id: "gemini-2.5-pro",
                name: "Gemini 2.5 Pro",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_048_576,
                maxTokens: 65_536,
              },
            ],
          },
        },
      },
    });
  });

  it("sets missing api to google-vertex for google-vertex provider", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        models: {
          providers: {
            "google-vertex": {
              baseUrl: "https://us-central1-aiplatform.googleapis.com",
              models: [
                {
                  id: "gemini-2.5-flash",
                  name: "Gemini 2.5 Flash",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1_048_576,
                  maxTokens: 65_536,
                },
              ],
            },
          },
        },
      },
    });

    expect(result.changes).toEqual(['Set models.providers.google-vertex.api to "google-vertex".']);
    expect(result.config).toEqual({
      models: {
        providers: {
          "google-vertex": {
            api: "google-vertex",
            baseUrl: "https://us-central1-aiplatform.googleapis.com",
            models: [
              {
                id: "gemini-2.5-flash",
                name: "Gemini 2.5 Flash",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_048_576,
                maxTokens: 65_536,
              },
            ],
          },
        },
      },
    });
  });

  it("sets missing api to google-generative-ai for google-antigravity provider", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        models: {
          providers: {
            "google-antigravity": {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              models: [
                {
                  id: "gemini-2.5-pro",
                  name: "Gemini 2.5 Pro",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1_048_576,
                  maxTokens: 65_536,
                },
              ],
            },
          },
        },
      },
    });

    expect(result.changes).toEqual([
      'Set models.providers.google-antigravity.api to "google-generative-ai".',
    ]);
  });

  it("sets missing api to google-generative-ai for google-gemini-cli provider", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        models: {
          providers: {
            "google-gemini-cli": {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              models: [
                {
                  id: "gemini-2.5-pro",
                  name: "Gemini 2.5 Pro",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1_048_576,
                  maxTokens: 65_536,
                },
              ],
            },
          },
        },
      },
    });

    expect(result.changes).toEqual([
      'Set models.providers.google-gemini-cli.api to "google-generative-ai".',
    ]);
  });

  it("preserves existing api when already set", () => {
    const cfg = {
      models: {
        providers: {
          google: {
            api: "google-generative-ai",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            models: [
              {
                id: "gemini-2.5-pro",
                name: "Gemini 2.5 Pro",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_048_576,
                maxTokens: 65_536,
              },
            ],
          },
        },
      },
    };

    const result = normalizeCompatibilityConfig({ cfg });

    expect(result.changes).toEqual([]);
    expect(result.config).toBe(cfg);
  });

  it("preserves non-Google providers untouched", () => {
    const cfg = {
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-completions",
            models: [
              {
                id: "some-model",
                name: "Some Model",
                reasoning: false,
                input: ["text"],
                cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 4_096,
              },
            ],
          },
        },
      },
    };

    const result = normalizeCompatibilityConfig({ cfg });

    expect(result.changes).toEqual([]);
    expect(result.config).toBe(cfg);
  });

  it("adds missing cacheWrite to model cost", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        models: {
          providers: {
            google: {
              api: "google-generative-ai",
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              models: [
                {
                  id: "gemini-2.5-pro",
                  name: "Gemini 2.5 Pro",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0 },
                  contextWindow: 1_048_576,
                  maxTokens: 65_536,
                },
              ],
            },
          },
        },
      },
    });

    expect(result.changes).toEqual(["Set models.providers.google.models[0].cost.cacheWrite to 0."]);
    expect(result.config.models.providers.google.models[0]).toMatchObject({
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("preserves model cost when cacheWrite already present", () => {
    const cfg = {
      models: {
        providers: {
          google: {
            api: "google-generative-ai",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            models: [
              {
                id: "gemini-2.5-pro",
                name: "Gemini 2.5 Pro",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0.5 },
                contextWindow: 1_048_576,
                maxTokens: 65_536,
              },
            ],
          },
        },
      },
    };

    const result = normalizeCompatibilityConfig({ cfg });

    expect(result.changes).toEqual([]);
    expect(result.config).toBe(cfg);
  });

  it("skips models without cost objects", () => {
    const cfg = {
      models: {
        providers: {
          google: {
            api: "google-generative-ai",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            models: [
              {
                id: "gemini-2.5-pro",
                name: "Gemini 2.5 Pro",
                reasoning: true,
                input: ["text", "image"],
                contextWindow: 1_048_576,
                maxTokens: 65_536,
              } as Record<string, unknown>,
            ],
          },
        },
      },
    };

    const result = normalizeCompatibilityConfig({ cfg: cfg as any });

    expect(result.changes).toEqual([]);
  });

  it("fixes both api and cacheWrite in a single pass", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              models: [
                {
                  id: "gemini-2.5-pro",
                  name: "Gemini 2.5 Pro",
                  reasoning: true,
                  input: ["text", "image", "audio", "video"],
                  cost: { input: 0, output: 0, cacheRead: 0 },
                  contextWindow: 1_048_576,
                  maxTokens: 65_536,
                },
              ],
            },
          },
        },
      },
    });

    expect(result.changes).toEqual([
      'Set models.providers.google.api to "google-generative-ai".',
      "Set models.providers.google.models[0].cost.cacheWrite to 0.",
    ]);

    const provider = result.config.models.providers.google;
    expect(provider.api).toBe("google-generative-ai");
    expect(provider.models[0].cost).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("no changes when config has no providers", () => {
    const cfg = { models: {} } as any;
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.changes).toEqual([]);
    expect(result.config).toBe(cfg);
  });

  it("no changes when models is absent", () => {
    const cfg = {} as any;
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.changes).toEqual([]);
    expect(result.config).toBe(cfg);
  });

  it("handles models array with non-record entries", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              models: [
                null,
                "not-an-object",
                42,
                {
                  id: "gemini-2.5-pro",
                  name: "Gemini 2.5 Pro",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0 },
                  contextWindow: 1_048_576,
                  maxTokens: 65_536,
                },
              ],
            },
          },
        },
      } as any,
    });

    expect(result.changes).toEqual([
      'Set models.providers.google.api to "google-generative-ai".',
      "Set models.providers.google.models[3].cost.cacheWrite to 0.",
    ]);
  });
});
