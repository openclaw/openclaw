import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const CHUIZI_BASE_URL = "https://api.chuizi.ai/v1";

// Chuizi.AI pricing (per 1M tokens, USD)
// https://chuizi.ai/pricing

const CLAUDE_SONNET_COST = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 3.75,
};

const CLAUDE_HAIKU_COST = {
  input: 1,
  output: 5,
  cacheRead: 0.1,
  cacheWrite: 1.25,
};

const CLAUDE_OPUS_COST = {
  input: 5,
  output: 25,
  cacheRead: 0.5,
  cacheWrite: 6.25,
};

const GPT_4_1_COST = {
  input: 2,
  output: 8,
  cacheRead: 0,
  cacheWrite: 0,
};

const DEEPSEEK_V3_COST = {
  input: 0.28,
  output: 0.42,
  cacheRead: 0,
  cacheWrite: 0,
};

const GEMINI_25_PRO_COST = {
  input: 1.25,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
};

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const CHUIZI_MODEL_CATALOG: ModelDefinitionConfig[] = [
  // Anthropic
  {
    id: "anthropic/claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 16000,
    cost: CLAUDE_SONNET_COST,
  },
  {
    id: "anthropic/claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 32000,
    cost: CLAUDE_OPUS_COST,
  },
  {
    id: "anthropic/claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: CLAUDE_HAIKU_COST,
  },
  // OpenAI
  {
    id: "openai/gpt-4.1",
    name: "GPT-4.1",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 32768,
    cost: GPT_4_1_COST,
  },
  {
    id: "openai/o4-mini",
    name: "o4-mini",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 100000,
    cost: ZERO_COST,
  },
  // Google
  {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: GEMINI_25_PRO_COST,
  },
  // DeepSeek
  {
    id: "deepseek/deepseek-chat",
    name: "DeepSeek V3.2",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: DEEPSEEK_V3_COST,
  },
  {
    id: "deepseek/deepseek-r1",
    name: "DeepSeek R1",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 65536,
    cost: DEEPSEEK_V3_COST,
  },
];

export function buildChuiziModelDefinition(
  model: (typeof CHUIZI_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
  };
}
