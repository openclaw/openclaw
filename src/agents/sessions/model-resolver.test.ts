// Model resolver tests pin the startup fallback order for fresh and restored
// agent sessions, and verify numeric-aware alias version resolution.
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

describe("parseModelPattern alias resolution", () => {
  it("selects numerically newest version when aliases span double-digit minor versions (#96588)", () => {
    // Simulate the scenario where a model family crosses into double-digit
    // minor versions: opus-4-9 vs opus-4-10. Plain localeCompare without
    // { numeric: true } sorts "opus-4-9" higher than "opus-4-10", picking
    // the OLDER model. With numeric collation, "4-10" > "4-9".
    const v9 = model("anthropic", "claude-opus-4-9");
    const v10 = model("anthropic", "claude-opus-4-10");
    const models = [v9, v10];

    const result = parseModelPattern("opus", models);

    expect(result.model).toBe(v10);
  });

  it("sorts multi-version aliases correctly when minor versions span single and double digits", () => {
    // When a family has versions opus-4-2, opus-4-9, opus-4-10, the resolver
    // must pick the numerically newest (4-10), not the lexicographically highest.
    const v2 = model("anthropic", "claude-opus-4-2");
    const v9 = model("anthropic", "claude-opus-4-9");
    const v10 = model("anthropic", "claude-opus-4-10");
    const models = [v2, v9, v10];

    const result = parseModelPattern("opus", models);

    expect(result.model).toBe(v10);
  });
});
