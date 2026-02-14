import { describe, expect, it } from "vitest";
import {
  discoverHuggingfaceModels,
  HUGGINGFACE_MODEL_CATALOG,
  buildHuggingfaceModelDefinition,
  isHuggingfacePolicyLocked,
} from "./huggingface-models.js";

describe("huggingface-models", () => {
  it("buildHuggingfaceModelDefinition returns config with required fields", () => {
    const entry = HUGGINGFACE_MODEL_CATALOG[0];
    const def = buildHuggingfaceModelDefinition(entry);
    expect(def.id).toBe(entry.id);
    expect(def.name).toBe(entry.name);
    expect(def.reasoning).toBe(entry.reasoning);
    expect(def.input).toEqual(entry.input);
    expect(def.cost).toEqual(entry.cost);
    expect(def.contextWindow).toBe(entry.contextWindow);
    expect(def.maxTokens).toBe(entry.maxTokens);
  });

  it("discoverHuggingfaceModels returns static catalog when apiKey is empty", async () => {
    const models = await discoverHuggingfaceModels("");
    expect(models).toHaveLength(HUGGINGFACE_MODEL_CATALOG.length);
    expect(models.map((m) => m.id)).toEqual(HUGGINGFACE_MODEL_CATALOG.map((m) => m.id));
  });

  it("discoverHuggingfaceModels returns static catalog in test env (VITEST)", async () => {
    const models = await discoverHuggingfaceModels("hf_test_token");
    expect(models).toHaveLength(HUGGINGFACE_MODEL_CATALOG.length);
    expect(models[0].id).toBe("deepseek-ai/DeepSeek-R1");
  });

  describe("isHuggingfacePolicyLocked", () => {
    it("returns true for :cheapest and :fastest refs", () => {
      expect(isHuggingfacePolicyLocked("huggingface/deepseek-ai/DeepSeek-R1:cheapest")).toBe(true);
      expect(isHuggingfacePolicyLocked("huggingface/deepseek-ai/DeepSeek-R1:fastest")).toBe(true);
    });
    it("returns false for base ref and :provider refs", () => {
      expect(isHuggingfacePolicyLocked("huggingface/deepseek-ai/DeepSeek-R1")).toBe(false);
      expect(isHuggingfacePolicyLocked("huggingface/foo:together")).toBe(false);
    });
  });
});
