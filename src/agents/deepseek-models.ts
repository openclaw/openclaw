import type { ModelDefinitionConfig } from "../config/types.models.js";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

// TODO: fill in actual DeepSeek API pricing
// https://api-docs.deepseek.com/quick_start/pricing
const DEEPSEEK_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const DEEPSEEK_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "deepseek-chat",
    name: "DeepSeek Chat",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: DEEPSEEK_DEFAULT_COST,
    compat: { supportsUsageInStreaming: true },
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek Reasoner",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 65536,
    cost: DEEPSEEK_DEFAULT_COST,
    compat: { supportsUsageInStreaming: true },
  },
];

export function buildDeepSeekModelDefinition(
  model: (typeof DEEPSEEK_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
  };
}
