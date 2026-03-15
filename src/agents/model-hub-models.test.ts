import { describe, expect, it } from "vitest";
import { MODEL_HUB_BASE_URL, MODEL_HUB_STATIC_CATALOG } from "../providers/model-hub-shared.js";
import { discoverModelHubModels } from "./model-hub-models.js";

describe("model-hub models", () => {
  it("uses the correct base URL", () => {
    expect(MODEL_HUB_BASE_URL).toBe("https://api.model-hub.cn/v1");
  });

  it("returns static catalog in test env", async () => {
    const models = await discoverModelHubModels("test-key");
    expect(models).toEqual(MODEL_HUB_STATIC_CATALOG);
    expect(models.length).toBeGreaterThan(0);
  });

  it("has required fields on all static catalog models", () => {
    for (const model of MODEL_HUB_STATIC_CATALOG) {
      expect(model.id).toBeTruthy();
      expect(model.name).toBeTruthy();
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxTokens).toBeGreaterThan(0);
      expect(model.cost).toBeDefined();
      expect(typeof model.reasoning).toBe("boolean");
      expect(model.input).toContain("text");
    }
  });
});
