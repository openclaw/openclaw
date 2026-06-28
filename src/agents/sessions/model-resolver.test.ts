// Model resolver tests pin the startup fallback order for fresh and restored
// agent sessions, plus numeric-aware alias sorting.
import { describe, expect, it } from "vitest";
import type { Model } from "../../llm/types.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import type { ModelRegistry } from "./model-registry.js";
import {
  findExactModelReferenceMatch,
  findInitialModel,
  parseModelPattern,
  restoreModelFromSession,
} from "./model-resolver.js";

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

function makeModel(id: string, provider = "anthropic"): Model {
  return { id, name: id, provider } as Model;
}

describe("parseModelPattern", () => {
  describe("numeric version sorting", () => {
    const models: Model[] = [
      makeModel("claude-opus-4-9"),
      makeModel("claude-opus-4-10"),
      makeModel("claude-opus-4-11"),
      makeModel("claude-sonnet-4-20250514"),
    ];

    it("selects numerically newest version when alias matches multiple versioned ids", () => {
      const result = parseModelPattern("opus", models);
      expect(result.model?.id).toBe("claude-opus-4-11");
    });

    it("selects numerically newest for partial match across double-digit versions", () => {
      const result = parseModelPattern("claude-opus-4", models);
      expect(result.model?.id).toBe("claude-opus-4-11");
    });

    it("selects version 10 over version 9 (lexicographic trap)", () => {
      const subset: Model[] = [makeModel("claude-opus-4-9"), makeModel("claude-opus-4-10")];
      const result = parseModelPattern("opus", subset);
      expect(result.model?.id).toBe("claude-opus-4-10");
    });

    it("handles single-digit versions correctly (no regression)", () => {
      const singleDigit: Model[] = [makeModel("claude-opus-4-1"), makeModel("claude-opus-4-9")];
      const result = parseModelPattern("opus", singleDigit);
      expect(result.model?.id).toBe("claude-opus-4-9");
    });
  });

  describe("dated version sorting", () => {
    const models: Model[] = [
      makeModel("claude-sonnet-4-20250514"),
      makeModel("claude-sonnet-4-20250620"),
    ];

    it("selects latest dated version", () => {
      const result = parseModelPattern("sonnet", models);
      expect(result.model?.id).toBe("claude-sonnet-4-20250620");
    });
  });
});

describe("findExactModelReferenceMatch", () => {
  it("returns undefined for empty pattern", () => {
    expect(findExactModelReferenceMatch("", [makeModel("claude-opus-4-10")])).toBeUndefined();
  });

  it("matches exact id", () => {
    expect(
      findExactModelReferenceMatch("claude-opus-4-10", [makeModel("claude-opus-4-10")])?.id,
    ).toBe("claude-opus-4-10");
  });
});
