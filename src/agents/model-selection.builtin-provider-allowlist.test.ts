import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import { buildAllowedModelSet } from "./model-selection.js";

/**
 * Regression tests for #16547: built-in providers (anthropic, openai, …)
 * should be recognised by buildAllowedModelSet even when no explicit
 * models.providers block is configured in openclaw.json.
 */
describe("buildAllowedModelSet — built-in provider allowlist (#16547)", () => {
  const catalog: ModelCatalogEntry[] = [
    { id: "claude-sonnet-4-5", name: "claude-sonnet-4-5", provider: "anthropic" },
    { id: "gpt-5.2", name: "gpt-5.2", provider: "openai" },
    { id: "kimi-k2.5", name: "kimi-k2.5", provider: "moonshot" },
  ];

  it("allows an allowlisted model from a built-in provider even when the exact model is not in the catalog", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": {},
            "moonshot/kimi-k2.5": {},
          },
        },
      },
    };

    const result = buildAllowedModelSet({
      cfg,
      catalog,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
    });

    // claude-opus-4-6 is NOT in the catalog, but anthropic IS a known
    // catalog provider → the allowlist entry should still be honoured.
    expect(result.allowedKeys.has("anthropic/claude-opus-4-6")).toBe(true);
    // moonshot/kimi-k2.5 IS directly in the catalog → allowed as before.
    expect(result.allowedKeys.has("moonshot/kimi-k2.5")).toBe(true);
  });

  it("rejects an allowlisted model from a completely unknown provider", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "unknown-corp/mystery-model": {},
          },
        },
      },
    };

    const result = buildAllowedModelSet({
      cfg,
      catalog,
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-5",
    });

    // "unknown-corp" is not in the catalog and not in configuredProviders
    // → the allowlist entry should NOT pass.
    expect(result.allowedKeys.has("unknown-corp/mystery-model")).toBe(false);
  });

  it("allows models from explicitly configured providers as before", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "custom-llm/custom-model": {},
          },
        },
      },
      models: {
        providers: {
          "custom-llm": { baseUrl: "https://custom.example.com" },
        },
      },
    };

    const result = buildAllowedModelSet({
      cfg,
      catalog,
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-5",
    });

    expect(result.allowedKeys.has("custom-llm/custom-model")).toBe(true);
  });

  it("still allows all catalog models when no allowlist is set", () => {
    const cfg: OpenClawConfig = {};

    const result = buildAllowedModelSet({
      cfg,
      catalog,
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-5",
    });

    expect(result.allowAny).toBe(true);
    expect(result.allowedKeys.has("anthropic/claude-sonnet-4-5")).toBe(true);
    expect(result.allowedKeys.has("openai/gpt-5.2")).toBe(true);
  });

  it("includes the default model even when it's not in the catalog or allowlist", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "moonshot/kimi-k2.5": {},
          },
        },
      },
    };

    const result = buildAllowedModelSet({
      cfg,
      catalog,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
    });

    // The default model is always added to allowedKeys.
    expect(result.allowedKeys.has("anthropic/claude-opus-4-6")).toBe(true);
  });
});
