import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Google config-compat tests cover legacy provider block normalization for the
// doctor contract: api backfill, input narrowing, cost.cacheWrite backfill, and
// mixed model-level API idempotency. See openclaw/openclaw#102138.
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./config-compat.js";

function ruleMatches(cfg: OpenClawConfig): boolean {
  return legacyConfigRules.some((rule) => {
    let value: unknown = cfg;
    for (const key of rule.path) {
      value =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)[key as string]
          : undefined;
    }
    return rule.match(value);
  });
}

function legacyGoogleCfg(): OpenClawConfig {
  return {
    models: {
      providers: {
        google: {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: { source: "file", provider: "filemain", id: "/google_apiKey" },
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
  } as unknown as OpenClawConfig;
}

describe("google legacy provider config compat", () => {
  it("detects a legacy google block", () => {
    expect(ruleMatches(legacyGoogleCfg())).toBe(true);
  });

  it("backfills api, narrows input, and fills cost.cacheWrite", () => {
    const { config, changes } = normalizeCompatibilityConfig({ cfg: legacyGoogleCfg() });
    const google = (config.models as any).providers.google;
    const model = google.models[0];

    expect(google.api).toBe("google-generative-ai");
    expect(model.input).toEqual(["text", "image"]);
    expect(model.cost).toEqual({ input: 1.25, output: 10, cacheRead: 0, cacheWrite: 0 });
    expect(changes.length).toBeGreaterThanOrEqual(3);
  });

  it("preserves the secret-ref apiKey and baseUrl", () => {
    const { config } = normalizeCompatibilityConfig({ cfg: legacyGoogleCfg() });
    const google = (config.models as any).providers.google;
    expect(google.apiKey).toEqual({ source: "file", provider: "filemain", id: "/google_apiKey" });
    expect(google.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("is idempotent: re-running the migrated config reports no changes", () => {
    const first = normalizeCompatibilityConfig({ cfg: legacyGoogleCfg() });
    expect(ruleMatches(first.config)).toBe(false);
    const second = normalizeCompatibilityConfig({ cfg: first.config });
    expect(second.changes).toHaveLength(0);
  });

  it("uses the google-vertex api for the google-vertex provider", () => {
    const cfg = {
      models: {
        providers: {
          "google-vertex": {
            baseUrl: "https://us-central1-aiplatform.googleapis.com/v1",
            models: [{ id: "gemini-2.5-flash", input: ["text", "image", "audio"] }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const { config } = normalizeCompatibilityConfig({ cfg });
    expect((config.models as any).providers["google-vertex"].api).toBe("google-vertex");
  });

  it("repairs a mixed model-api block so no model is left without an api (idempotent)", () => {
    // Provider has no api; one model sets api, one does not. The old core impl
    // detected this but skipped the provider-api backfill, leaving the
    // api-less model still invalid at catalog load. The repair must leave every
    // model resolvable and re-detection must return false.
    const cfg = {
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            models: [
              { id: "gemini-2.5-pro", api: "google-generative-ai", input: ["text", "image"] },
              { id: "gemini-2.5-flash", input: ["text", "image"] },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const { config } = normalizeCompatibilityConfig({ cfg });
    const google = (config.models as any).providers.google;
    // Every model must end up with an api (provider-level or model-level).
    const providerApi = google.api;
    for (const model of google.models) {
      expect(model.api ?? providerApi).toBeTruthy();
    }
    expect(ruleMatches(config)).toBe(false);
  });

  it("does not overwrite a user-set provider api", () => {
    const cfg = {
      models: {
        providers: {
          google: {
            api: "custom-google-api",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            models: [{ id: "gemini-2.5-pro", input: ["text", "image", "audio"] }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const { config } = normalizeCompatibilityConfig({ cfg });
    expect((config.models as any).providers.google.api).toBe("custom-google-api");
  });

  it("leaves models without a cost object untouched", () => {
    const cfg = {
      models: {
        providers: {
          google: {
            api: "google-generative-ai",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            models: [{ id: "gemini-2.5-pro", input: ["text", "image"] }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const { changes } = normalizeCompatibilityConfig({ cfg });
    expect(changes).toHaveLength(0);
  });

  it("does not touch non-google providers", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "gpt-5.4",
                input: ["text", "image", "audio", "video"],
                cost: { input: 1, output: 2, cacheRead: 0 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(ruleMatches(cfg)).toBe(false);
    const { changes } = normalizeCompatibilityConfig({ cfg });
    expect(changes).toHaveLength(0);
  });

  it("handles non-record model entries without throwing", () => {
    const cfg = {
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            models: [null, "gemini-2.5-pro"],
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(() => normalizeCompatibilityConfig({ cfg })).not.toThrow();
  });
});
