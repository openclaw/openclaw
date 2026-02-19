import type { ModelDefinitionConfig } from "../config/types.models.js";

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

export const GROQ_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "llama-3.3-70b-versatile",
    name: "Llama 3.3 70B",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    cost: {
      input: 0.59,
      output: 0.79,
      cacheRead: 0.59,
      cacheWrite: 0.79,
    },
  },
  {
    id: "mixtral-8x7b-32768",
    name: "Mixtral 8x7B",
    reasoning: false,
    input: ["text"],
    contextWindow: 32768,
    maxTokens: 8192,
    cost: {
      input: 0.24,
      output: 0.24,
      cacheRead: 0.24,
      cacheWrite: 0.24,
    },
  },
  {
    id: "deepseek-r1-distill-llama-70b",
    name: "DeepSeek R1 Distill Llama 70B",
    reasoning: true,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    cost: {
      input: 0.75,
      output: 0.99,
      cacheRead: 0.75,
      cacheWrite: 0.99,
    },
  },
];

export function buildGroqModelDefinition(
  model: (typeof GROQ_MODEL_CATALOG)[number],
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
