import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const POLLINATIONS_BASE_URL = "https://gen.pollinations.ai";
const POLLINATIONS_DEFAULT_MODEL_ID = "pollinations/openai";
const POLLINATIONS_DEFAULT_CONTEXT_WINDOW = 400000;
const POLLINATIONS_DEFAULT_MAX_TOKENS = 8192;
const POLLINATIONS_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function buildPollinationsProvider(): ModelProviderConfig {
  return {
    baseUrl: POLLINATIONS_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: POLLINATIONS_DEFAULT_MODEL_ID,
        name: "Pollinations OpenAI",
        reasoning: false,
        input: ["text", "image"],
        cost: POLLINATIONS_DEFAULT_COST,
        contextWindow: POLLINATIONS_DEFAULT_CONTEXT_WINDOW,
        maxTokens: POLLINATIONS_DEFAULT_MAX_TOKENS,
      },
      {
        id: "pollinations/deepseek",
        name: "Pollinations DeepSeek",
        reasoning: true,
        input: ["text"],
        cost: POLLINATIONS_DEFAULT_COST,
        contextWindow: 1048576,
        maxTokens: 8192,
      },
      {
        id: "pollinations/gemini-fast",
        name: "Pollinations Gemini Fast",
        reasoning: false,
        input: ["text", "image", "audio", "video"],
        cost: POLLINATIONS_DEFAULT_COST,
        contextWindow: 1048576,
        maxTokens: 8192,
      },
      {
        id: "pollinations/claude-fast",
        name: "Pollinations Claude Fast",
        reasoning: false,
        input: ["text", "image"],
        cost: POLLINATIONS_DEFAULT_COST,
        contextWindow: 200000,
        maxTokens: 8192,
      },
      {
        id: "pollinations/openai-fast",
        name: "Pollinations OpenAI Fast",
        reasoning: false,
        input: ["text", "image"],
        cost: POLLINATIONS_DEFAULT_COST,
        contextWindow: 400000,
        maxTokens: 8192,
      },
      {
        id: "pollinations/gpt-5.6-sol",
        name: "Pollinations GPT-5.6 Sol",
        reasoning: true,
        input: ["text", "image"],
        cost: POLLINATIONS_DEFAULT_COST,
        contextWindow: 1050000,
        maxTokens: 8192,
      },
    ],
  };
}
