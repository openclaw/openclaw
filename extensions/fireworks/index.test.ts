import { describe, expect, it } from "vitest";
import {
  buildFireworksModelDefinition,
  discoverFireworksModels,
  FIREWORKS_BASE_URL,
  FIREWORKS_DEFAULT_MODEL_ID,
  FIREWORKS_DEFAULT_MODEL_REF,
  FIREWORKS_MODEL_CATALOG,
} from "../../src/agents/fireworks-models.js";

describe("fireworks-models", () => {
  it("has a valid default model ref", () => {
    expect(FIREWORKS_DEFAULT_MODEL_REF).toBe(`fireworks/${FIREWORKS_DEFAULT_MODEL_ID}`);
  });

  it("has a valid base URL", () => {
    expect(FIREWORKS_BASE_URL).toBe("https://api.fireworks.ai/inference/v1");
  });

  it("default model ID exists in catalog", () => {
    const ids = FIREWORKS_MODEL_CATALOG.map((m) => m.id);
    expect(ids).toContain(FIREWORKS_DEFAULT_MODEL_ID);
  });

  it("all catalog entries have required fields", () => {
    for (const entry of FIREWORKS_MODEL_CATALOG) {
      expect(entry.id).toBeTruthy();
      expect(entry.name).toBeTruthy();
      expect(typeof entry.reasoning).toBe("boolean");
      expect(entry.input.length).toBeGreaterThan(0);
      expect(entry.contextWindow).toBeGreaterThan(0);
      expect(entry.maxTokens).toBeGreaterThan(0);
    }
  });

  it("all catalog IDs use the accounts/fireworks/models/ prefix", () => {
    for (const entry of FIREWORKS_MODEL_CATALOG) {
      expect(entry.id).toMatch(/^accounts\/fireworks\/models\//);
    }
  });

  it("catalog has no duplicate IDs", () => {
    const ids = FIREWORKS_MODEL_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("buildFireworksModelDefinition returns config with required fields", () => {
    const entry = FIREWORKS_MODEL_CATALOG[0];
    const def = buildFireworksModelDefinition(entry);
    expect(def.id).toBe(entry.id);
    expect(def.name).toBe(entry.name);
    expect(def.reasoning).toBe(entry.reasoning);
    expect(def.input).toEqual(expect.arrayContaining([...entry.input]));
    expect(def.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(def.contextWindow).toBe(entry.contextWindow);
    expect(def.maxTokens).toBe(entry.maxTokens);
  });

  it("discoverFireworksModels returns all catalog models", () => {
    const models = discoverFireworksModels();
    expect(models).toHaveLength(FIREWORKS_MODEL_CATALOG.length);
    expect(models.map((m) => m.id)).toEqual(FIREWORKS_MODEL_CATALOG.map((m) => m.id));
  });
});
