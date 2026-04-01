import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const ERNIE_BASE_URL = "https://qianfan.baidubce.com/v2";
export const ERNIE_DEFAULT_MODEL_ID = "ernie-5.0-thinking-preview";
const ERNIE_DEFAULT_CONTEXT_WINDOW = 119000;
const ERNIE_DEFAULT_MAX_TOKENS = 64000;
const ERNIE_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function buildErnieProvider(): ModelProviderConfig {
  return {
    baseUrl: ERNIE_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: ERNIE_DEFAULT_MODEL_ID,
        name: "ERNIE 5.0",
        reasoning: true,
        input: ["text", "image"],
        cost: ERNIE_DEFAULT_COST,
        contextWindow: ERNIE_DEFAULT_CONTEXT_WINDOW,
        maxTokens: ERNIE_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}
