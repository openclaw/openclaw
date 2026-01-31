import { describe, expect, it } from "vitest";

import {
  getSiliconflowStaticFallbackModels,
  SILICONFLOW_MODEL_ALIASES,
  resolveSiliconflowAlias,
  resolveSiliconflowModelApi,
} from "./siliconflow-models.js";

describe("resolveSiliconflowAlias", () => {
  it("resolves deepseek alias", () => {
    expect(resolveSiliconflowAlias("deepseek")).toBe("Pro/deepseek/DeepSeek-R1");
  });

  it("resolves glm alias", () => {
    expect(resolveSiliconflowAlias("glm")).toBe("Pro/zai-org/GLM-4.7");
  });

  it("resolves qwen alias", () => {
    expect(resolveSiliconflowAlias("qwen")).toBe("Pro/Qwen/Qwen2.5-72B-Instruct");
  });

  it("resolves llama alias", () => {
    expect(resolveSiliconflowAlias("llama")).toBe("Pro/meta-llama/Llama-3.3-70B-Instruct");
  });

  it("returns input if no alias exists", () => {
    expect(resolveSiliconflowAlias("some-unknown-model")).toBe("some-unknown-model");
  });

  it("is case-insensitive", () => {
    expect(resolveSiliconflowAlias("DEEPSEEK")).toBe("Pro/deepseek/DeepSeek-R1");
    expect(resolveSiliconflowAlias("GLM")).toBe("Pro/zai-org/GLM-4.7");
  });
});

describe("resolveSiliconflowModelApi", () => {
  it("returns openai-completions for all models", () => {
    expect(resolveSiliconflowModelApi("Pro/deepseek/DeepSeek-R1")).toBe("openai-completions");
    expect(resolveSiliconflowModelApi("Pro/zai-org/GLM-4.7")).toBe("openai-completions");
    expect(resolveSiliconflowModelApi("some-unknown-model")).toBe("openai-completions");
  });
});

describe("getSiliconflowStaticFallbackModels", () => {
  it("returns an array of models", () => {
    const models = getSiliconflowStaticFallbackModels();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBe(11);
  });

  it("includes DeepSeek, GLM, Qwen, and Llama models", () => {
    const models = getSiliconflowStaticFallbackModels();
    const ids = models.map((m) => m.id);

    // Pro tier
    expect(ids).toContain("Pro/deepseek/DeepSeek-R1");
    expect(ids).toContain("Pro/zai-org/GLM-4.7");
    expect(ids).toContain("Pro/Qwen/Qwen2.5-72B-Instruct");
    expect(ids).toContain("Pro/meta-llama/Llama-3.3-70B-Instruct");

    // Free tier
    expect(ids).toContain("deepseek-ai/DeepSeek-R1-Distill-Qwen-7B");
    expect(ids).toContain("Qwen/Qwen2.5-7B-Instruct");
    expect(ids).toContain("THUDM/glm-4-9b-chat");
  });

  it("returns valid ModelDefinitionConfig objects", () => {
    const models = getSiliconflowStaticFallbackModels();
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
    const models = getSiliconflowStaticFallbackModels();
    const deepseekR1 = models.find((m) => m.id === "Pro/deepseek/DeepSeek-R1");
    const glm = models.find((m) => m.id === "Pro/zai-org/GLM-4.7");
    const qwen = models.find((m) => m.id === "Pro/Qwen/Qwen2.5-72B-Instruct");

    expect(deepseekR1?.reasoning).toBe(true);
    expect(glm?.reasoning).toBe(true);
    expect(qwen?.reasoning).toBe(false);
  });
});

describe("SILICONFLOW_MODEL_ALIASES", () => {
  it("has expected aliases", () => {
    expect(SILICONFLOW_MODEL_ALIASES.deepseek).toBe("Pro/deepseek/DeepSeek-R1");
    expect(SILICONFLOW_MODEL_ALIASES.glm).toBe("Pro/zai-org/GLM-4.7");
    expect(SILICONFLOW_MODEL_ALIASES.qwen).toBe("Pro/Qwen/Qwen2.5-72B-Instruct");
    expect(SILICONFLOW_MODEL_ALIASES.llama).toBe("Pro/meta-llama/Llama-3.3-70B-Instruct");
    expect(SILICONFLOW_MODEL_ALIASES.yi).toBe("Pro/01-ai/Yi-1.5-34B-Chat");
  });
});
