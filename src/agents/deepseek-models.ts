import type { ModelDefinitionConfig } from "../config/types.models.js";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

// Pricing: https://api-docs.deepseek.com/quick_start/pricing
// Rates are per 1M tokens (same unit as other providers in this file).
const DEEPSEEK_DEFAULT_COST = {
  input: 0.14,
  output: 0.28,
  cacheRead: 0.0028,
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
