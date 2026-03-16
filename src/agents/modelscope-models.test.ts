// src/agents/modelscope-models.test.ts
import { describe, expect, it } from "vitest";
import {
  discoverModelScopeModels,
  MODELSCOPE_MODEL_CATALOG,
  buildModelScopeModelDefinition,
} from "./modelscope-models.js";

describe("modelscope-models", () => {
  it("buildModelScopeModelDefinition returns config with required fields", () => {
    const entry = MODELSCOPE_MODEL_CATALOG[0];
    const def = buildModelScopeModelDefinition(entry);
    expect(def.id).toBe(entry.id);
    expect(def.name).toBe(entry.name);
    expect(def.reasoning).toBe(entry.reasoning);
    expect(def.input).toEqual(entry.input);
    expect(def.cost).toEqual(entry.cost);
    expect(def.contextWindow).toBe(entry.contextWindow);
    expect(def.maxTokens).toBe(entry.maxTokens);
  });

  it("discoverModelScopeModels returns static catalog in test environment", async () => {
    // In test environment, always returns static catalog regardless of apiKey
    const modelsWithKey = await discoverModelScopeModels("test-api-key");
    const modelsWithoutKey = await discoverModelScopeModels("");

    expect(modelsWithKey).toHaveLength(MODELSCOPE_MODEL_CATALOG.length);
    expect(modelsWithoutKey).toHaveLength(MODELSCOPE_MODEL_CATALOG.length);

    // Verify first model
    expect(modelsWithKey[0].id).toBe("Qwen/Qwen3-8B");
    expect(modelsWithoutKey[0].id).toBe("Qwen/Qwen3-8B");
  });
});
