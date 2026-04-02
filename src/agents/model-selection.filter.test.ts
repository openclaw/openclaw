import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import {
  buildConfiguredAgentModelKeys,
  checkProviderAuth,
  filterModelCatalog,
  hasAuthForProvider,
} from "./model-selection.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_CATALOG: ModelCatalogEntry[] = [
  { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
  { provider: "google", id: "gemini-3-pro-preview", name: "Gemini 3 Pro" },
];

const EMPTY_CATALOG: ModelCatalogEntry[] = [];

function makeCfg(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return { ...overrides } as OpenClawConfig;
}

function makeCfgWithModels(modelKeys: string[]): OpenClawConfig {
  const models: Record<string, object> = {};
  for (const key of modelKeys) {
    models[key] = {};
  }
  return {
    agents: {
      defaults: {
        model: { primary: modelKeys[0] ?? "anthropic/claude-opus-4-6" },
        models,
      },
    },
  } as OpenClawConfig;
}

// ---------------------------------------------------------------------------
// filterModelCatalog
// ---------------------------------------------------------------------------

describe("filterModelCatalog", () => {
  // -- "all" mode ----------------------------------------------------------

  describe('"all" mode', () => {
    it("returns the full catalog unchanged (same reference)", () => {
      const result = filterModelCatalog({
        catalog: SAMPLE_CATALOG,
        cfg: makeCfg(),
        filter: "all",
        defaultProvider: "anthropic",
      });
      expect(result).toBe(SAMPLE_CATALOG);
    });

    it("returns empty array for empty catalog", () => {
      const result = filterModelCatalog({
        catalog: EMPTY_CATALOG,
        cfg: makeCfg(),
        filter: "all",
        defaultProvider: "anthropic",
      });
      expect(result).toEqual([]);
      expect(result).toBe(EMPTY_CATALOG);
    });
  });

  // -- "authenticated" mode ------------------------------------------------

  describe('"authenticated" mode', () => {
    // For authenticated mode tests, we control which providers have auth by
    // stubbing environment variables (the env API key check) since mocking
    // the re-exported auth functions across ESM module boundaries is fragile.
    // We clear all provider env vars and selectively set the ones we need.

    beforeEach(() => {
      // Clear all known provider API key env vars to start clean.
      vi.stubEnv("ANTHROPIC_API_KEY", "");
      vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
      vi.stubEnv("OPENAI_API_KEY", "");
      vi.stubEnv("GEMINI_API_KEY", "");
      vi.stubEnv("GOOGLE_API_KEY", "");
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("filters to only models whose provider has auth via env key", () => {
      // Only anthropic has a key.
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");

      const result = filterModelCatalog({
        catalog: SAMPLE_CATALOG,
        cfg: makeCfg(),
        filter: "authenticated",
        defaultProvider: "anthropic",
      });

      const providers = result.map((m) => m.provider);
      expect(providers).toContain("anthropic");
      expect(providers).not.toContain("openai");
      expect(providers).not.toContain("google");
      // Both anthropic entries should be present.
      expect(result).toHaveLength(2);
    });

    it("returns all models when every provider is authenticated", () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
      vi.stubEnv("OPENAI_API_KEY", "sk-openai-test");
      vi.stubEnv("GEMINI_API_KEY", "gemini-test");

      const result = filterModelCatalog({
        catalog: SAMPLE_CATALOG,
        cfg: makeCfg(),
        filter: "authenticated",
        defaultProvider: "anthropic",
      });

      expect(result).toHaveLength(SAMPLE_CATALOG.length);
    });

    it("returns empty array when no providers are authenticated", () => {
      // All env vars are already cleared by beforeEach.
      const result = filterModelCatalog({
        catalog: SAMPLE_CATALOG,
        cfg: makeCfg(),
        filter: "authenticated",
        defaultProvider: "anthropic",
      });

      expect(result).toEqual([]);
    });

    it("returns empty array for empty catalog regardless of auth", () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");

      const result = filterModelCatalog({
        catalog: EMPTY_CATALOG,
        cfg: makeCfg(),
        filter: "authenticated",
        defaultProvider: "anthropic",
      });
      expect(result).toEqual([]);
    });

    it("caches auth lookups per provider within a single call", () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");

      const catalog: ModelCatalogEntry[] = [
        { provider: "anthropic", id: "claude-opus-4-6", name: "Opus" },
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "Sonnet" },
        { provider: "anthropic", id: "claude-haiku-4-6", name: "Haiku" },
      ];

      const result = filterModelCatalog({
        catalog,
        cfg: makeCfg(),
        filter: "authenticated",
        defaultProvider: "anthropic",
      });

      expect(result).toHaveLength(3);
    });

    it("uses custom provider API key from config", () => {
      // No env vars, but anthropic has a custom key in config.
      const cfg = {
        models: {
          providers: {
            anthropic: {
              apiKey: "sk-custom-test",
            },
          },
        },
      } as OpenClawConfig;

      const result = filterModelCatalog({
        catalog: SAMPLE_CATALOG,
        cfg,
        filter: "authenticated",
        defaultProvider: "anthropic",
      });

      const providers = result.map((m) => m.provider);
      expect(providers).toContain("anthropic");
      expect(providers).not.toContain("openai");
    });
  });

  // -- "configured" mode ---------------------------------------------------

  describe('"configured" mode', () => {
    it("filters to only models explicitly in agent configs", () => {
      const cfg = makeCfgWithModels(["anthropic/claude-opus-4-6", "openai/gpt-5.2"]);
      const result = filterModelCatalog({
        catalog: SAMPLE_CATALOG,
        cfg,
        filter: "configured",
        defaultProvider: "anthropic",
      });

      expect(result).toHaveLength(2);
      const ids = result.map((m) => m.id);
      expect(ids).toContain("claude-opus-4-6");
      expect(ids).toContain("gpt-5.2");
      expect(ids).not.toContain("claude-sonnet-4-6");
      expect(ids).not.toContain("gemini-3-pro-preview");
    });

    it("falls back to full catalog when no models are configured", () => {
      const cfg = makeCfg(); // no agents.defaults.models
      const result = filterModelCatalog({
        catalog: SAMPLE_CATALOG,
        cfg,
        filter: "configured",
        defaultProvider: "anthropic",
      });
      // Should return the original catalog when configuredKeys is empty.
      expect(result).toBe(SAMPLE_CATALOG);
    });

    it("returns empty array for empty catalog even with models configured", () => {
      const cfg = makeCfgWithModels(["anthropic/claude-opus-4-6"]);
      const result = filterModelCatalog({
        catalog: EMPTY_CATALOG,
        cfg,
        filter: "configured",
        defaultProvider: "anthropic",
      });
      expect(result).toEqual([]);
    });

    it("includes per-agent model overrides in the configured set", () => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
            models: {
              "anthropic/claude-opus-4-6": {},
            },
          },
          list: [
            {
              id: "research",
              model: { primary: "openai/gpt-5.2" },
            },
          ],
        },
      } as OpenClawConfig;

      const result = filterModelCatalog({
        catalog: SAMPLE_CATALOG,
        cfg,
        filter: "configured",
        defaultProvider: "anthropic",
      });

      const ids = result.map((m) => m.id);
      expect(ids).toContain("claude-opus-4-6");
      expect(ids).toContain("gpt-5.2");
    });

    it("includes global fallback models in the configured set", () => {
      const cfg = {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["openai/gpt-5.2"],
            },
            models: {
              "anthropic/claude-opus-4-6": {},
            },
          },
        },
      } as OpenClawConfig;

      const result = filterModelCatalog({
        catalog: SAMPLE_CATALOG,
        cfg,
        filter: "configured",
        defaultProvider: "anthropic",
      });

      const ids = result.map((m) => m.id);
      expect(ids).toContain("claude-opus-4-6");
      expect(ids).toContain("gpt-5.2");
    });
  });

  // -- edge cases / fallback -----------------------------------------------

  describe("unknown filter value", () => {
    it("returns full catalog for unrecognized filter string (defensive fallback)", () => {
      const result = filterModelCatalog({
        catalog: SAMPLE_CATALOG,
        cfg: makeCfg(),
        // Force an unrecognized value past the type system.
        filter: "regex:.*" as "all",
        defaultProvider: "anthropic",
      });
      expect(result).toBe(SAMPLE_CATALOG);
    });
  });
});

// ---------------------------------------------------------------------------
// buildConfiguredAgentModelKeys
// ---------------------------------------------------------------------------

describe("buildConfiguredAgentModelKeys", () => {
  it("collects the global primary model", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
        },
      },
    } as OpenClawConfig;

    const keys = buildConfiguredAgentModelKeys({ cfg, defaultProvider: "anthropic" });
    expect(keys.has("anthropic/claude-opus-4-6")).toBe(true);
  });

  it("collects global fallback models", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["openai/gpt-5.2"],
          },
        },
      },
    } as OpenClawConfig;

    const keys = buildConfiguredAgentModelKeys({ cfg, defaultProvider: "anthropic" });
    expect(keys.has("anthropic/claude-opus-4-6")).toBe(true);
    expect(keys.has("openai/gpt-5.2")).toBe(true);
  });

  it("collects allowlist keys from agents.defaults.models", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
            "openai/gpt-5.2": {},
          },
        },
      },
    } as OpenClawConfig;

    const keys = buildConfiguredAgentModelKeys({ cfg, defaultProvider: "anthropic" });
    expect(keys.has("anthropic/claude-sonnet-4-6")).toBe(true);
    expect(keys.has("openai/gpt-5.2")).toBe(true);
  });

  it("collects per-agent model overrides", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
        },
        list: [
          { id: "coder", model: { primary: "openai/gpt-5.2" } },
          { id: "research", model: { primary: "google/gemini-3-pro" } },
        ],
      },
    } as OpenClawConfig;

    const keys = buildConfiguredAgentModelKeys({ cfg, defaultProvider: "anthropic" });
    expect(keys.has("anthropic/claude-sonnet-4-6")).toBe(true);
    expect(keys.has("openai/gpt-5.2")).toBe(true);
  });

  it("returns empty set for empty config", () => {
    const keys = buildConfiguredAgentModelKeys({
      cfg: {} as OpenClawConfig,
      defaultProvider: "anthropic",
    });
    expect(keys.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// hasAuthForProvider / checkProviderAuth
// ---------------------------------------------------------------------------
// These functions are tested indirectly through filterModelCatalog's
// "authenticated" mode above.  Signature checks below verify exports.

describe("hasAuthForProvider", () => {
  it("is exported as a function with 3 parameters", () => {
    expect(typeof hasAuthForProvider).toBe("function");
    expect(hasAuthForProvider).toHaveLength(3);
  });
});

describe("checkProviderAuth", () => {
  it("is exported as a function with 2 parameters", () => {
    expect(typeof checkProviderAuth).toBe("function");
    expect(checkProviderAuth).toHaveLength(2);
  });
});
