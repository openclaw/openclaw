import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import { buildAllowedModelSet, modelKey } from "./model-selection.js";

describe("buildAllowedModelSet edge cases", () => {
  it("model NOT in catalog and provider NOT in models.providers IS NOW allowed (fix for #6295)", async () => {
    const cfg: Partial<OpenClawConfig> = {
      agents: {
        defaults: {
          models: {
            "google-antigravity/gemini-3-pro": {},
          },
        },
      },
      // Note: NO models.providers configured!
    };

    const mockCatalog: ModelCatalogEntry[] = [];

    const allowed = buildAllowedModelSet({
      cfg: cfg as OpenClawConfig,
      catalog: mockCatalog,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
    });

    const testKey = modelKey("google-antigravity", "gemini-3-pro");

    // After fix: the model IS allowed
    expect(allowed.allowedKeys.has(testKey)).toBe(true);
  });

  it("model in catalog is allowed even without provider config", async () => {
    const cfg: Partial<OpenClawConfig> = {
      agents: {
        defaults: {
          models: {
            "google-antigravity/gemini-3-pro": {},
          },
        },
      },
    };

    // Model IS in catalog
    const mockCatalog: ModelCatalogEntry[] = [
      { id: "gemini-3-pro", name: "Gemini 3 Pro", provider: "google-antigravity" },
    ];

    const allowed = buildAllowedModelSet({
      cfg: cfg as OpenClawConfig,
      catalog: mockCatalog,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
    });

    const testKey = modelKey("google-antigravity", "gemini-3-pro");

    // When model is in catalog, it's allowed
    expect(allowed.allowedKeys.has(testKey)).toBe(true);
  });

  it("model with provider in models.providers is allowed", async () => {
    const cfg: Partial<OpenClawConfig> = {
      agents: {
        defaults: {
          models: {
            "google-antigravity/gemini-3-pro": {},
          },
        },
      },
      models: {
        providers: {
          "google-antigravity": {},
        },
      },
    };

    const mockCatalog: ModelCatalogEntry[] = [];

    const allowed = buildAllowedModelSet({
      cfg: cfg as OpenClawConfig,
      catalog: mockCatalog,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
    });

    const testKey = modelKey("google-antigravity", "gemini-3-pro");

    // When provider is configured, model is allowed
    expect(allowed.allowedKeys.has(testKey)).toBe(true);
  });
});
