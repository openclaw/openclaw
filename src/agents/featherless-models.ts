import type { ModelDefinitionConfig } from "../config/types.models.js";

export const FEATHERLESS_BASE_URL = "https://api.featherless.ai/v1";

export const FEATHERLESS_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "MiniMaxAI/MiniMax-M2.5",
    name: "MiniMax M2.5",
    reasoning: false,
    input: ["text"],
    contextWindow: 256000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "moonshotai/Kimi-K2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 32768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "zai-org/GLM-4.7",
    name: "GLM 4.7",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "deepseek-ai/DeepSeek-V3",
    name: "DeepSeek V3",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
];

export function buildFeatherlessModelDefinition(
  model: (typeof FEATHERLESS_MODEL_CATALOG)[number],
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
