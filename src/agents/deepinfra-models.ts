import type { ModelDefinitionConfig } from "../config/types.models.js";

export const DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai";

export const DEEPINFRA_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    name: "Llama 3.3 70B Instruct Turbo",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: {
      input: 0.35,
      output: 0.4,
      cacheRead: 0.35,
      cacheWrite: 0.4,
    },
  },
  {
    id: "meta-llama/Llama-3.3-70B-Instruct",
    name: "Llama 3.3 70B Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: {
      input: 0.35,
      output: 0.4,
      cacheRead: 0.35,
      cacheWrite: 0.4,
    },
  },
  {
    id: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
    name: "Llama 4 Scout",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 524288,
    maxTokens: 32768,
    cost: {
      input: 0.15,
      output: 0.4,
      cacheRead: 0.15,
      cacheWrite: 0.4,
    },
  },
  {
    id: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
    name: "Llama 4 Maverick",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 524288,
    maxTokens: 32768,
    cost: {
      input: 0.2,
      output: 0.6,
      cacheRead: 0.2,
      cacheWrite: 0.6,
    },
  },
  {
    id: "deepseek-ai/DeepSeek-V3-0324",
    name: "DeepSeek V3",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: {
      input: 0.5,
      output: 0.9,
      cacheRead: 0.5,
      cacheWrite: 0.9,
    },
  },
  {
    id: "deepseek-ai/DeepSeek-R1",
    name: "DeepSeek R1",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: {
      input: 3.0,
      output: 7.0,
      cacheRead: 3.0,
      cacheWrite: 7.0,
    },
  },
  {
    id: "Qwen/Qwen3-235B-A22B",
    name: "Qwen 3 235B",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: {
      input: 0.5,
      output: 1.0,
      cacheRead: 0.5,
      cacheWrite: 1.0,
    },
  },
  {
    id: "Qwen/Qwen2.5-Coder-32B-Instruct",
    name: "Qwen 2.5 Coder 32B",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: {
      input: 0.2,
      output: 0.2,
      cacheRead: 0.2,
      cacheWrite: 0.2,
    },
  },
  {
    id: "google/gemma-3-27b-it",
    name: "Gemma 3 27B",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: {
      input: 0.1,
      output: 0.2,
      cacheRead: 0.1,
      cacheWrite: 0.2,
    },
  },
];

export function buildDeepinfraModelDefinition(
  model: (typeof DEEPINFRA_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    api: "openai-completions",
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}
