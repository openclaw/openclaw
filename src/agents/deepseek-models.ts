import type { ModelDefinitionConfig } from "../config/types.models.js";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

// DeepSeek V3.2 pricing (per 1M tokens) — https://api-docs.deepseek.com/quick_start/pricing
const DEEPSEEK_DEFAULT_COST = {
  input: 0.28, // cache miss
  output: 0.42,
  cacheRead: 0.028, // cache hit
  cacheWrite: 0,
};

export const DEEPSEEK_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "deepseek-chat",
    name: "DeepSeek Chat (V3.2 Non-thinking)",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: DEEPSEEK_DEFAULT_COST,
    compat: { supportsUsageInStreaming: true },
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek Reasoner (V3.2 Thinking)",
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
