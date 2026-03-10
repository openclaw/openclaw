import { describe, expect, it } from "vitest";
import {
  AZURE_FOUNDRY_ANTHROPIC_API_VERSION,
  AZURE_FOUNDRY_ANTHROPIC_MODELS,
  AZURE_FOUNDRY_MODEL_CATALOG,
  buildAzureFoundryAnthropicModelDefinition,
  buildAzureFoundryModelDefinition,
  isAnthropicModelId,
} from "./azure-foundry-models.js";

describe("azure-foundry-models", () => {
  it("catalog contains expected models", () => {
    expect(AZURE_FOUNDRY_MODEL_CATALOG.length).toBeGreaterThanOrEqual(10);
    const ids = AZURE_FOUNDRY_MODEL_CATALOG.map((m) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).toContain("o4-mini");
    expect(ids).toContain("DeepSeek-R1");
  });

  it("every catalog entry has required fields", () => {
    for (const model of AZURE_FOUNDRY_MODEL_CATALOG) {
      expect(model.id).toBeTruthy();
      expect(model.name).toBeTruthy();
      expect(typeof model.reasoning).toBe("boolean");
      expect(model.input.length).toBeGreaterThan(0);
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxTokens).toBeGreaterThan(0);
      expect(model.cost).toBeDefined();
    }
  });

  it("buildAzureFoundryModelDefinition stamps api field", () => {
    const entry = AZURE_FOUNDRY_MODEL_CATALOG[0];
    const def = buildAzureFoundryModelDefinition(entry);
    expect(def.api).toBe("openai-completions");
    expect(def.id).toBe(entry.id);
    expect(def.name).toBe(entry.name);
    expect(def.reasoning).toBe(entry.reasoning);
    expect(def.input).toEqual(entry.input);
    expect(def.cost).toEqual(entry.cost);
    expect(def.contextWindow).toBe(entry.contextWindow);
    expect(def.maxTokens).toBe(entry.maxTokens);
  });

  it("costs are zero for all catalog entries", () => {
    for (const model of AZURE_FOUNDRY_MODEL_CATALOG) {
      expect(model.cost.input).toBe(0);
      expect(model.cost.output).toBe(0);
      expect(model.cost.cacheRead).toBe(0);
      expect(model.cost.cacheWrite).toBe(0);
    }
  });
});

describe("azure-foundry-anthropic-models", () => {
  it("anthropic catalog contains Claude models", () => {
    expect(AZURE_FOUNDRY_ANTHROPIC_MODELS.length).toBeGreaterThanOrEqual(1);
    const ids = AZURE_FOUNDRY_ANTHROPIC_MODELS.map((m) => m.id);
    expect(ids).toContain("claude-sonnet-4-6");
  });

  it("every anthropic catalog entry has required fields", () => {
    for (const model of AZURE_FOUNDRY_ANTHROPIC_MODELS) {
      expect(model.id).toBeTruthy();
      expect(model.name).toBeTruthy();
      expect(typeof model.reasoning).toBe("boolean");
      expect(model.input.length).toBeGreaterThan(0);
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxTokens).toBeGreaterThan(0);
      expect(model.cost).toBeDefined();
    }
  });

  it("buildAzureFoundryAnthropicModelDefinition sets anthropic api and baseUrl", () => {
    const entry = AZURE_FOUNDRY_ANTHROPIC_MODELS[0];
    const baseUrl = "https://my-resource.services.ai.azure.com/anthropic";
    const def = buildAzureFoundryAnthropicModelDefinition(entry, baseUrl);
    expect(def.api).toBe("anthropic-messages");
    expect(def.baseUrl).toBe(baseUrl);
    expect(def.headers).toEqual({ "api-version": AZURE_FOUNDRY_ANTHROPIC_API_VERSION });
    expect(def.id).toBe(entry.id);
    expect(def.name).toBe(entry.name);
  });

  it("costs are zero for all anthropic catalog entries", () => {
    for (const model of AZURE_FOUNDRY_ANTHROPIC_MODELS) {
      expect(model.cost.input).toBe(0);
      expect(model.cost.output).toBe(0);
      expect(model.cost.cacheRead).toBe(0);
      expect(model.cost.cacheWrite).toBe(0);
    }
  });
});

describe("isAnthropicModelId", () => {
  it("returns true for claude model ids", () => {
    expect(isAnthropicModelId("claude-sonnet-4-6")).toBe(true);
    expect(isAnthropicModelId("claude-haiku-3-5-20241022")).toBe(true);
    expect(isAnthropicModelId("Claude-Opus-4")).toBe(true);
  });

  it("returns false for non-claude model ids", () => {
    expect(isAnthropicModelId("gpt-4o")).toBe(false);
    expect(isAnthropicModelId("DeepSeek-R1")).toBe(false);
    expect(isAnthropicModelId("o4-mini")).toBe(false);
  });
});
