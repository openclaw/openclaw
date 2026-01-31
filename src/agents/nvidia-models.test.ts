import { describe, expect, it } from "vitest";

import {
  getNvidiaStaticFallbackModels,
  NVIDIA_MODEL_ALIASES,
  resolveNvidiaAlias,
  resolveNvidiaModelApi,
} from "./nvidia-models.js";

describe("resolveNvidiaAlias", () => {
  it("resolves llama alias", () => {
    expect(resolveNvidiaAlias("llama")).toBe("nvidia/llama-3.3-70b-instruct");
  });

  it("resolves glm alias", () => {
    expect(resolveNvidiaAlias("glm")).toBe("z-ai/glm4.7");
  });

  it("resolves deepseek alias", () => {
    expect(resolveNvidiaAlias("deepseek")).toBe("deepseek-ai/deepseek-r1");
  });

  it("returns input if no alias exists", () => {
    expect(resolveNvidiaAlias("some-unknown-model")).toBe("some-unknown-model");
  });

  it("is case-insensitive", () => {
    expect(resolveNvidiaAlias("LLAMA")).toBe("nvidia/llama-3.3-70b-instruct");
    expect(resolveNvidiaAlias("DeepSeek")).toBe("deepseek-ai/deepseek-r1");
  });
});

describe("resolveNvidiaModelApi", () => {
  it("returns openai-completions for all models", () => {
    expect(resolveNvidiaModelApi("nvidia/llama-3.3-70b-instruct")).toBe("openai-completions");
    expect(resolveNvidiaModelApi("z-ai/glm4.7")).toBe("openai-completions");
    expect(resolveNvidiaModelApi("deepseek-ai/deepseek-r1")).toBe("openai-completions");
    expect(resolveNvidiaModelApi("some-unknown-model")).toBe("openai-completions");
  });
});

describe("getNvidiaStaticFallbackModels", () => {
  it("returns an array of models", () => {
    const models = getNvidiaStaticFallbackModels();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBe(11);
  });

  it("includes Llama, GLM, DeepSeek, Qwen, and Mistral models", () => {
    const models = getNvidiaStaticFallbackModels();
    const ids = models.map((m) => m.id);

    expect(ids).toContain("nvidia/llama-3.3-70b-instruct");
    expect(ids).toContain("z-ai/glm4.7");
    expect(ids).toContain("deepseek-ai/deepseek-r1");
    expect(ids).toContain("qwen/qwen2.5-72b-instruct");
    expect(ids).toContain("mistralai/mistral-large-2-instruct");
  });

  it("returns valid ModelDefinitionConfig objects", () => {
    const models = getNvidiaStaticFallbackModels();
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
    const models = getNvidiaStaticFallbackModels();
    const deepseekR1 = models.find((m) => m.id === "deepseek-ai/deepseek-r1");
    const glm = models.find((m) => m.id === "z-ai/glm4.7");
    const llama = models.find((m) => m.id === "nvidia/llama-3.3-70b-instruct");

    expect(deepseekR1?.reasoning).toBe(true);
    expect(glm?.reasoning).toBe(true);
    expect(llama?.reasoning).toBe(false);
  });
});

describe("NVIDIA_MODEL_ALIASES", () => {
  it("has expected aliases", () => {
    expect(NVIDIA_MODEL_ALIASES.llama).toBe("nvidia/llama-3.3-70b-instruct");
    expect(NVIDIA_MODEL_ALIASES.glm).toBe("z-ai/glm4.7");
    expect(NVIDIA_MODEL_ALIASES.deepseek).toBe("deepseek-ai/deepseek-r1");
    expect(NVIDIA_MODEL_ALIASES.qwen).toBe("qwen/qwen2.5-72b-instruct");
    expect(NVIDIA_MODEL_ALIASES.mistral).toBe("mistralai/mistral-large-2-instruct");
  });
});
