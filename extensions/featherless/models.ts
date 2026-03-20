import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const FEATHERLESS_BASE_URL = "https://api.featherless.ai/v1";

export const FEATHERLESS_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "MiniMaxAI/MiniMax-M2.5",
    name: "MiniMax M2.5",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 131072,
  },
  {
    id: "moonshotai/Kimi-K2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  },
  {
    id: "THUDM/GLM-4.7-9B-Chat",
    name: "GLM 4.7 9B",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "deepseek-ai/DeepSeek-V3-0324",
    name: "DeepSeek V3",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
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
