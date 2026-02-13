import type { ModelDefinitionConfig } from "../config/types.models.js";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
export const DEEPSEEK_DEFAULT_MODEL_ID = "deepseek-chat";
export const DEEPSEEK_REASONING_MODEL_ID = "deepseek-reasoner";

// Pricing source: https://api-docs.deepseek.com/quick_start/pricing
// Keep these values in USD per 1M tokens.
const DEEPSEEK_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const DEEPSEEK_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: DEEPSEEK_DEFAULT_MODEL_ID,
    name: "DeepSeek Chat",
    reasoning: false,
    input: ["text"],
    contextWindow: 65536,
    maxTokens: 8192,
    cost: DEEPSEEK_DEFAULT_COST,
  },
  {
    id: DEEPSEEK_REASONING_MODEL_ID,
    name: "DeepSeek Reasoner",
    reasoning: true,
    input: ["text"],
    contextWindow: 65536,
    maxTokens: 8192,
    cost: DEEPSEEK_DEFAULT_COST,
  },
];
