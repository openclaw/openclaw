import type { ModelDefinitionConfig } from "../config/types.models.js";

export const HPC_AI_BASE_URL = "https://api.hpc-ai.com/inference/v1";

export const HPC_AI_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "minimax/minimax-m2.5",
    name: "MiniMax M2.5",
    reasoning: true,
    input: ["text"],
    contextWindow: 196000,
    maxTokens: 65536,
    cost: {
      input: 0.3,
      output: 1.2,
      cacheRead: 0.03,
      cacheWrite: 0,
    },
  },
  {
    id: "moonshotai/kimi-k2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 256000,
    maxTokens: 64000,
    cost: {
      input: 0.45,
      output: 2.25,
      cacheRead: 0.07,
      cacheWrite: 0,
    },
  },
];

export function buildHpcAiModelDefinition(
  model: (typeof HPC_AI_MODEL_CATALOG)[number],
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
