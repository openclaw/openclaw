import { describe, expect, it } from "vitest";
import { buildNvidiaProvider } from "./provider-catalog.js";

describe("nvidia provider catalog", () => {
  it("builds the bundled NVIDIA provider defaults", () => {
    const provider = buildNvidiaProvider();

    expect(provider.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(provider.api).toBe("openai-completions");
    expect(provider.models.map((model) => model.id)).toEqual([
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/nemotron-3-8b-instruct",
      "nvidia/nemotron-4-340b-instruct",
      "meta/llama-3.3-70b-instruct",
      "meta/llama-4-maverick-17b-128e-instruct",
      "meta/llama-4-scout-17b-16e-instruct",
      "mistralai/mistral-small-3.2-24b-instruct",
      "mistralai/mixtral-8x22b-instruct-v0.1",
      "google/gemma-3-27b-it",
      "microsoft/phi-4",
      "moonshotai/kimi-k2.5",
      "minimaxai/minimax-m2.5",
      "z-ai/glm5",
      "qwen/qwen3-235b-a22b-2507",
      "qwen/qwq-32b",
      "deepseek-ai/deepseek-r1-0528",
    ]);
  });

  it("has correct default model properties", () => {
    const provider = buildNvidiaProvider();
    const defaultModel = provider.models[0];

    expect(defaultModel.id).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(defaultModel.name).toBe("NVIDIA Nemotron 3 Super 120B");
    expect(defaultModel.reasoning).toBe(false);
    expect(defaultModel.input).toEqual(["text"]);
    expect(defaultModel.contextWindow).toBe(262144);
    expect(defaultModel.maxTokens).toBe(8192);
    expect(defaultModel.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("includes multimodal models", () => {
    const provider = buildNvidiaProvider();
    const multimodalModels = provider.models.filter((m) => m.input.includes("image"));

    expect(multimodalModels.map((m) => m.id)).toEqual([
      "meta/llama-4-maverick-17b-128e-instruct",
      "meta/llama-4-scout-17b-16e-instruct",
    ]);
  });

  it("includes reasoning models", () => {
    const provider = buildNvidiaProvider();
    const reasoningModels = provider.models.filter((m) => m.reasoning);

    expect(reasoningModels.map((m) => m.id)).toEqual([
      "qwen/qwq-32b",
      "deepseek-ai/deepseek-r1-0528",
    ]);
  });
});
