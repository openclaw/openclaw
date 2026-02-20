import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

export const GROQ_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "llama-3.1-405b-reasoning",
    name: "Llama 3.1 405B Reasoning",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  },
  {
    id: "llama-3.1-70b-versatile",
    name: "Llama 3.1 70B Versatile",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  },
  {
    id: "llama-3.1-8b-instant",
    name: "Llama 3.1 8B Instant",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  },
  {
    id: "mixtral-8x7b-32768",
    name: "Mixtral 8x7B 32768",
    reasoning: false,
    input: ["text"],
    contextWindow: 32768,
    maxTokens: 32768,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  },
  {
    id: "gemma2-9b-it",
    name: "Gemma 2 9B IT",
    reasoning: false,
    input: ["text"],
    contextWindow: 8192,
    maxTokens: 8192,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
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

export function buildGroqProvider(): ModelProviderConfig {
  return {
    baseUrl: GROQ_BASE_URL,
    api: "openai-completions",
    models: GROQ_MODEL_CATALOG.map(buildGroqModelDefinition),
  };
}
