import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const CHUIZI_BASE_URL = "https://api.chuizi.ai/v1";

// Chuizi.AI pricing (per 1M tokens, USD).
// Prices are upstream list prices × Chuizi's 1.05 gateway margin.
// Reference: https://chuizi.ai/pricing

// ---- Anthropic ----
const CLAUDE_OPUS_COST = {
  input: 15.75,
  output: 78.75,
  cacheRead: 1.575,
  cacheWrite: 19.6875,
};
const CLAUDE_SONNET_COST = {
  input: 3.15,
  output: 15.75,
  cacheRead: 0.315,
  cacheWrite: 3.9375,
};
const CLAUDE_HAIKU_COST = {
  input: 1.05,
  output: 5.25,
  cacheRead: 0.105,
  cacheWrite: 1.3125,
};

// ---- OpenAI ----
const GPT_5_COST = {
  input: 1.3125,
  output: 10.5,
  cacheRead: 0.13125,
  cacheWrite: 0,
};
const GPT_5_MINI_COST = {
  input: 0.2625,
  output: 2.1,
  cacheRead: 0.02625,
  cacheWrite: 0,
};
const GPT_4_1_COST = {
  input: 2.1,
  output: 8.4,
  cacheRead: 0,
  cacheWrite: 0,
};
const GPT_4_1_MINI_COST = {
  input: 0.42,
  output: 1.68,
  cacheRead: 0,
  cacheWrite: 0,
};
const O4_MINI_COST = {
  input: 1.155,
  output: 4.62,
  cacheRead: 0.2888,
  cacheWrite: 0,
};

// ---- Google ----
const GEMINI_25_PRO_COST = {
  input: 1.3125,
  output: 10.5,
  cacheRead: 0.328,
  cacheWrite: 0,
};
const GEMINI_25_FLASH_COST = {
  input: 0.315,
  output: 2.625,
  cacheRead: 0.0788,
  cacheWrite: 0,
};

// ---- DeepSeek ----
const DEEPSEEK_V3_COST = {
  input: 0.294,
  output: 1.176,
  cacheRead: 0.029,
  cacheWrite: 0,
};
const DEEPSEEK_R1_COST = {
  input: 0.588,
  output: 2.352,
  cacheRead: 0.029,
  cacheWrite: 0,
};

// ---- Qwen ----
const QWEN3_MAX_COST = {
  input: 2.52,
  output: 10.08,
  cacheRead: 0,
  cacheWrite: 0,
};

// ---- xAI ----
const GROK_4_COST = {
  input: 3.15,
  output: 15.75,
  cacheRead: 0.7875,
  cacheWrite: 0,
};

// ---- Moonshot ----
const KIMI_K25_COST = {
  input: 2.52,
  output: 12.6,
  cacheRead: 0,
  cacheWrite: 0,
};

// ---- Zhipu ----
const GLM_46_COST = {
  input: 0.525,
  output: 2.1,
  cacheRead: 0,
  cacheWrite: 0,
};

export const CHUIZI_MODEL_CATALOG: ModelDefinitionConfig[] = [
  // Anthropic
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
    id: "anthropic/claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    cost: CLAUDE_SONNET_COST,
  },
  {
    id: "anthropic/claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 32000,
    cost: CLAUDE_HAIKU_COST,
  },

  // OpenAI
  {
    id: "openai/gpt-5",
    name: "GPT-5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400000,
    maxTokens: 128000,
    cost: GPT_5_COST,
  },
  {
    id: "openai/gpt-5-mini",
    name: "GPT-5 mini",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400000,
    maxTokens: 128000,
    cost: GPT_5_MINI_COST,
  },
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
    id: "openai/gpt-4.1-mini",
    name: "GPT-4.1 mini",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 32768,
    cost: GPT_4_1_MINI_COST,
  },
  {
    id: "openai/o4-mini",
    name: "o4-mini",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 100000,
    cost: O4_MINI_COST,
  },

  // Google
  {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 2097152,
    maxTokens: 65536,
    cost: GEMINI_25_PRO_COST,
  },
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: GEMINI_25_FLASH_COST,
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
    compat: { supportsUsageInStreaming: true },
  },
  {
    id: "deepseek/deepseek-r1",
    name: "DeepSeek R1",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 65536,
    cost: DEEPSEEK_R1_COST,
    compat: { supportsUsageInStreaming: true },
  },

  // Qwen
  {
    id: "qwen/qwen3-max",
    name: "Qwen3 Max",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 8192,
    cost: QWEN3_MAX_COST,
  },

  // xAI
  {
    id: "xai/grok-4",
    name: "Grok 4",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 256000,
    maxTokens: 32768,
    cost: GROK_4_COST,
  },

  // Moonshot
  {
    id: "moonshot/kimi-k2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 65536,
    cost: KIMI_K25_COST,
  },

  // Zhipu
  {
    id: "zhipu/glm-4.6",
    name: "GLM-4.6",
    reasoning: true,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 32768,
    cost: GLM_46_COST,
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
