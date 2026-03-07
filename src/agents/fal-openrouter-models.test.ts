import { describe, expect, it } from "vitest";
import {
  buildFalOpenrouterModelDefinition,
  FAL_OPENROUTER_BASE_URL,
  FAL_OPENROUTER_MODEL_CATALOG,
} from "./fal-openrouter-models.js";

describe("FAL_OPENROUTER_MODEL_CATALOG", () => {
  it("contains at least one model", () => {
    expect(FAL_OPENROUTER_MODEL_CATALOG.length).toBeGreaterThan(0);
  });

  it("every model has required fields", () => {
    for (const model of FAL_OPENROUTER_MODEL_CATALOG) {
      expect(model.id).toBeTruthy();
      expect(model.name).toBeTruthy();
      expect(typeof model.reasoning).toBe("boolean");
      expect(model.input).toEqual(expect.arrayContaining([expect.any(String)]));
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxTokens).toBeGreaterThan(0);
      expect(model.cost).toBeDefined();
    }
  });
});

describe("buildFalOpenrouterModelDefinition", () => {
  it("sets api to openai-completions", () => {
    const def = buildFalOpenrouterModelDefinition(FAL_OPENROUTER_MODEL_CATALOG[0]);
    expect(def.api).toBe("openai-completions");
  });

  it("preserves model fields from catalog entry", () => {
    const source = FAL_OPENROUTER_MODEL_CATALOG[0];
    const def = buildFalOpenrouterModelDefinition(source);
    expect(def.id).toBe(source.id);
    expect(def.name).toBe(source.name);
    expect(def.reasoning).toBe(source.reasoning);
    expect(def.input).toEqual(source.input);
    expect(def.cost).toEqual(source.cost);
    expect(def.contextWindow).toBe(source.contextWindow);
    expect(def.maxTokens).toBe(source.maxTokens);
  });
});

describe("FAL_OPENROUTER_BASE_URL", () => {
  it("points to fal openrouter endpoint", () => {
    expect(FAL_OPENROUTER_BASE_URL).toBe("https://fal.run/openrouter/router/openai/v1");
  });
});
