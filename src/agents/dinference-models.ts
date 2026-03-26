import type { ModelDefinitionConfig } from "../config/types.models.js";

export const DINFERENCE_BASE_URL = "https://api.dinference.com/v1";

export const DINFERENCE_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "glm-5",
    name: "GLM 5",
    reasoning: true,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 128000,
    cost: {
      input: 0.75,
      output: 2.4,
      cacheRead: 0.0,
      cacheWrite: 0.0,
    },
  },
  {
    id: "glm-4.7",
    name: "GLM 4.7",
    reasoning: true,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 128000,
    cost: {
      input: 0.45,
      output: 1.65,
      cacheRead: 0.0,
      cacheWrite: 0.0,
    },
  },
  {
    id: "gpt-oss-120b",
    name: "GPT-OSS 120B",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 32768,
    cost: {
      input: 0.0675,
      output: 0.27,
      cacheRead: 0.0,
      cacheWrite: 0.0,
    },
  },
];

export function buildDinferenceModelDefinition(
  model: (typeof DINFERENCE_MODEL_CATALOG)[number],
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
