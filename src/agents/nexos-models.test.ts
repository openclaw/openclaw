import { describe, expect, it } from "vitest";
import {
  buildNexosModelDefinition,
  discoverNexosModels,
  NEXOS_BASE_URL,
  NEXOS_DEFAULT_COST,
  NEXOS_DEFAULT_MODEL_ID,
  NEXOS_DEFAULT_MODEL_REF,
  NEXOS_MODEL_CATALOG,
} from "./nexos-models.js";

describe("nexos-models", () => {
  it("exports expected base URL", () => {
    expect(NEXOS_BASE_URL).toBe("https://api.nexos.ai/v1");
  });

  it("exports a default model reference that matches nexos/<id>", () => {
    expect(NEXOS_DEFAULT_MODEL_REF).toBe(`nexos/${NEXOS_DEFAULT_MODEL_ID}`);
  });

  it("catalog contains at least one model", () => {
    expect(NEXOS_MODEL_CATALOG.length).toBeGreaterThan(0);
  });

  it("buildNexosModelDefinition returns config with required fields", () => {
    const entry = NEXOS_MODEL_CATALOG[0];
    const def = buildNexosModelDefinition(entry);
    expect(def.id).toBe(entry.id);
    expect(def.name).toBe(entry.name);
    expect(def.reasoning).toBe(entry.reasoning);
    expect(def.input).toEqual([...entry.input]);
    expect(def.cost).toEqual(NEXOS_DEFAULT_COST);
    expect(def.contextWindow).toBe(entry.contextWindow);
    expect(def.maxTokens).toBe(entry.maxTokens);
  });

  it("builds valid definitions for every catalog entry", () => {
    for (const entry of NEXOS_MODEL_CATALOG) {
      const def = buildNexosModelDefinition(entry);
      expect(def.id).toBeTruthy();
      expect(def.name).toBeTruthy();
      expect(typeof def.reasoning).toBe("boolean");
      expect(Array.isArray(def.input)).toBe(true);
      expect(def.input.length).toBeGreaterThan(0);
      expect(def.contextWindow).toBeGreaterThan(0);
      expect(def.maxTokens).toBeGreaterThan(0);
    }
  });

  it("default model exists in the catalog", () => {
    const ids = NEXOS_MODEL_CATALOG.map((m) => m.id);
    expect(ids).toContain(NEXOS_DEFAULT_MODEL_ID);
  });

  it("all catalog entries have unique IDs", () => {
    const ids = NEXOS_MODEL_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("discoverNexosModels", () => {
  it("returns static catalog in test environment", async () => {
    const models = await discoverNexosModels("test-key");
    expect(models.length).toBe(NEXOS_MODEL_CATALOG.length);
    for (const model of models) {
      expect(model.id).toBeTruthy();
      expect(model.name).toBeTruthy();
      expect(typeof model.reasoning).toBe("boolean");
    }
  });

  it("returns static catalog when apiKey is empty", async () => {
    const models = await discoverNexosModels("");
    expect(models.length).toBe(NEXOS_MODEL_CATALOG.length);
  });

  it("is exported and callable", () => {
    expect(typeof discoverNexosModels).toBe("function");
  });
});
