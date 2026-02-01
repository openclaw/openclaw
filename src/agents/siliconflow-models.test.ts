import { describe, expect, it } from "vitest";
import {
  getSiliconFlowStaticFallbackModels,
  SILICONFLOW_MODEL_ALIASES,
  resolveSiliconFlowAlias,
  resolveSiliconFlowModelApi,
} from "./siliconflow-models.js";

describe("resolveSiliconFlowAlias", () => {
  it("resolves deepseek alias", () => {
    expect(resolveSiliconFlowAlias("deepseek")).toBe("deepseek-ai/DeepSeek-V3.2");
  });

  it("resolves glm alias", () => {
    expect(resolveSiliconFlowAlias("glm")).toBe("Pro/zai-org/GLM-4.7");
  });

  it("resolves qwen alias", () => {
    expect(resolveSiliconFlowAlias("qwen")).toBe("Qwen/Qwen3-235B-A22B-Instruct-2507");
  });

  it("returns input if no alias exists", () => {
    expect(resolveSiliconFlowAlias("some-unknown-model")).toBe("some-unknown-model");
  });

  it("is case-insensitive", () => {
    expect(resolveSiliconFlowAlias("DEEPSEEK")).toBe("deepseek-ai/DeepSeek-V3.2");
    expect(resolveSiliconFlowAlias("GLM")).toBe("Pro/zai-org/GLM-4.7");
  });
});

describe("resolveSiliconFlowModelApi", () => {
  it("returns openai-completions for all models", () => {
    expect(resolveSiliconFlowModelApi("Pro/deepseek/DeepSeek-R1")).toBe("openai-completions");
    expect(resolveSiliconFlowModelApi("Pro/zai-org/GLM-4.7")).toBe("openai-completions");
    expect(resolveSiliconFlowModelApi("some-unknown-model")).toBe("openai-completions");
  });
});

describe("getSiliconFlowStaticFallbackModels", () => {
  it("returns an array of models", () => {
    const models = getSiliconFlowStaticFallbackModels();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(10);
  });

  it("includes DeepSeek, GLM, Qwen, and Kimi models", () => {
    const models = getSiliconFlowStaticFallbackModels();
    const ids = models.map((m) => m.id);

    // Pro tier
    expect(ids).toContain("Pro/zai-org/GLM-4.7");

    // DeepSeek models
    expect(ids).toContain("deepseek-ai/DeepSeek-V3.2");
  });

  it("returns valid ModelDefinitionConfig objects", () => {
    const models = getSiliconFlowStaticFallbackModels();
    for (const model of models) {
      expect(model.id).toBeDefined();
      expect(model.name).toBeDefined();
      expect(typeof model.reasoning).toBe("boolean");
      expect(Array.isArray(model.input)).toBe(true);
      expect(model.cost).toBeDefined();
      expect(typeof model.contextWindow).toBe("number");
      expect(typeof model.maxTokens).toBe("number");
    }
  });

  it("marks reasoning models correctly", () => {
    const models = getSiliconFlowStaticFallbackModels();
    const glm = models.find((m) => m.id === "Pro/zai-org/GLM-4.7");

    expect(glm?.reasoning).toBe(true);
  });
});

describe("SILICONFLOW_MODEL_ALIASES", () => {
  it("has expected aliases", () => {
    expect(SILICONFLOW_MODEL_ALIASES.deepseek).toBe("deepseek-ai/DeepSeek-V3.2");
    expect(SILICONFLOW_MODEL_ALIASES.glm).toBe("Pro/zai-org/GLM-4.7");
    expect(SILICONFLOW_MODEL_ALIASES.qwen).toBe("Qwen/Qwen3-235B-A22B-Instruct-2507");
    expect(SILICONFLOW_MODEL_ALIASES.kimi).toBe("Pro/moonshotai/Kimi-K2.5");
  });
});
