import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

const DEEPSEEK_CONTEXT_WINDOW = 1_000_000;
const DEEPSEEK_V4_MAX_TOKENS = 384_000;
const DEEPSEEK_LEGACY_REASONER_MAX_TOKENS = 65_536;

const DEEPSEEK_COMPAT = {
  supportsUsageInStreaming: true,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
} satisfies NonNullable<ModelDefinitionConfig["compat"]>;

// DeepSeek V4 API pricing (per 1M tokens)
// https://api-docs.deepseek.com/quick_start/pricing
const DEEPSEEK_V4_FLASH_COST = {
  input: 1,
  output: 2,
  cacheRead: 0.2,
  cacheWrite: 0,
};

const DEEPSEEK_V4_PRO_COST = {
  input: 12,
  output: 24,
  cacheRead: 1,
  cacheWrite: 0,
};

export const DEEPSEEK_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    reasoning: true,
    input: ["text"],
    contextWindow: DEEPSEEK_CONTEXT_WINDOW,
    maxTokens: DEEPSEEK_V4_MAX_TOKENS,
    cost: DEEPSEEK_V4_FLASH_COST,
    compat: DEEPSEEK_COMPAT,
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    reasoning: true,
    input: ["text"],
    contextWindow: DEEPSEEK_CONTEXT_WINDOW,
    maxTokens: DEEPSEEK_V4_MAX_TOKENS,
    cost: DEEPSEEK_V4_PRO_COST,
    compat: DEEPSEEK_COMPAT,
  },
  {
    id: "deepseek-chat",
    name: "DeepSeek Chat (legacy)",
    reasoning: false,
    input: ["text"],
    contextWindow: DEEPSEEK_CONTEXT_WINDOW,
    maxTokens: DEEPSEEK_V4_MAX_TOKENS,
    cost: DEEPSEEK_V4_FLASH_COST,
    compat: DEEPSEEK_COMPAT,
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek Reasoner (legacy)",
    reasoning: true,
    input: ["text"],
    contextWindow: DEEPSEEK_CONTEXT_WINDOW,
    maxTokens: DEEPSEEK_LEGACY_REASONER_MAX_TOKENS,
    cost: DEEPSEEK_V4_FLASH_COST,
    compat: DEEPSEEK_COMPAT,
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
