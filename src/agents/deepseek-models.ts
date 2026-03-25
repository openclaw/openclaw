import type { ModelDefinitionConfig } from "../config/types.models.js";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

// DeepSeek API pricing (per 1M tokens)
// https://api-docs.deepseek.com/quick_start/pricing
const DEEPSEEK_CHAT_COST = {
  input: 0.27,
  output: 1.10,
  cacheRead: 0.07,
  cacheWrite: 0,
};

const DEEPSEEK_REASONER_COST = {
  input: 0.55,
  output: 2.19,
  cacheRead: 0.14,
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
    cost: DEEPSEEK_CHAT_COST,
    compat: { supportsUsageInStreaming: true },
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek Reasoner",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 65536,
    cost: DEEPSEEK_REASONER_COST,
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
