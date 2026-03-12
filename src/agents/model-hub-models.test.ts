import { describe, expect, it } from "vitest";
import {
  MODEL_HUB_BASE_URL,
  MODEL_HUB_DEFAULT_MODEL_ID,
  MODEL_HUB_DEFAULT_MODEL_NAME,
} from "../providers/model-hub-shared.js";
import { MODEL_HUB_MODELS_URL, discoverModelHubModels } from "./model-hub-models.js";

describe("model-hub-models", () => {
  it("should have the correct models URL", () => {
    expect(MODEL_HUB_MODELS_URL).toBe(`${MODEL_HUB_BASE_URL}/models`);
  });

  it("should return static catalog in test environment", async () => {
    const models = await discoverModelHubModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].id).toBe(MODEL_HUB_DEFAULT_MODEL_ID);
    expect(models[0].name).toBe(MODEL_HUB_DEFAULT_MODEL_NAME);
  });

  it("should include required fields in static catalog models", async () => {
    const models = await discoverModelHubModels();
    for (const model of models) {
      expect(model.id).toBeDefined();
      expect(model.name).toBeDefined();
      expect(typeof model.reasoning).toBe("boolean");
      expect(Array.isArray(model.input)).toBe(true);
      expect(model.cost).toBeDefined();
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxTokens).toBeGreaterThan(0);
    }
  });
});
