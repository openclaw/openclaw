// Model resolver tests pin the startup fallback order for fresh and restored
// agent sessions.
import { describe, expect, it } from "vitest";
import type { Model } from "../../llm/types.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import type { ModelRegistry } from "./model-registry.js";
import { findInitialModel, parseModelPattern, restoreModelFromSession } from "./model-resolver.js";

function model(provider: string, id: string): Model {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider,
    baseUrl: `https://${provider}.example.test`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function registry(models: Model[]): ModelRegistry {
  return {
    find: (provider: string, modelId: string) =>
      models.find((entry) => entry.provider === provider && entry.id === modelId),
    getAvailable: () => models,
    hasConfiguredAuth: (entry: Model) => models.includes(entry),
  } as ModelRegistry;
}

describe("model resolver fallback selection", () => {
  it("prefers the product default when no configured or scoped model is selected", async () => {
    const productDefault = model(DEFAULT_PROVIDER, DEFAULT_MODEL);
    const result = await findInitialModel({
      scopedModels: [],
      isContinuing: false,
      modelRegistry: registry([model("anthropic", "claude-opus-4.7"), productDefault]),
    });

    expect(result.model).toBe(productDefault);
  });

  it("falls back to registry order instead of core provider defaults", async () => {
    // Restored sessions can reference removed models; choose an authenticated
    // registry model rather than reviving a hard-coded provider default.
    const firstAvailable = model("anthropic", "claude-haiku");
    const result = await restoreModelFromSession(
      "openai",
      "missing-model",
      undefined,
      false,
      registry([firstAvailable, model("anthropic", "claude-opus-4.7")]),
    );

    expect(result.model).toBe(firstAvailable);
  });
});

describe("parseModelPattern alias ordering", () => {
  it("picks the numerically newest version when an alias hits double-digit minors (#96588)", () => {
    // Plain localeCompare would order `4-9` above `4-10` because the digit
    // `9` ranks above `1` lexicographically. Numeric-aware collation keeps
    // the numerically newer version on top.
    const v9 = model("anthropic", "claude-opus-4-9");
    const v10 = model("anthropic", "claude-opus-4-10");
    const result = parseModelPattern("opus", [v9, v10]);

    expect(result.model).toBe(v10);
  });

  it("picks the numerically newest version regardless of input order", () => {
    // Test lists in both orderings to prove the comparator (not list order)
    // is responsible for the result.
    const v9 = model("anthropic", "claude-opus-4-9");
    const v10 = model("anthropic", "claude-opus-4-10");
    const reversed = parseModelPattern("opus", [v10, v9]);

    expect(reversed.model).toBe(v10);
  });

  it("keeps single-digit behavior unchanged (regression guard)", () => {
    // Today's shipped catalogs use single-digit minors where text and numeric
    // order agree; the fix must not change the existing selection.
    const v7 = model("anthropic", "claude-opus-4-7");
    const v8 = model("anthropic", "claude-opus-4-8");
    const result = parseModelPattern("opus", [v7, v8]);

    expect(result.model).toBe(v8);
  });
});
