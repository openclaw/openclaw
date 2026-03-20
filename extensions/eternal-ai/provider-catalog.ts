import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-models";

export const ETERNAL_AI_BASE_URL = "https://open.eternalai.org/v1";
export const ETERNAL_AI_DEFAULT_MODEL_ID = "uncensored-eternal-ai-1.0";

const ETERNAL_AI_DEFAULT_CONTEXT_WINDOW = 200000;
const ETERNAL_AI_DEFAULT_MAX_TOKENS = 200000;

export function buildEternalAiProvider(): ModelProviderConfig {
  return {
    baseUrl: ETERNAL_AI_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: ETERNAL_AI_DEFAULT_MODEL_ID,
        name: "Uncensored Eternal AI 1.0",
        reasoning: false,
        input: ["text"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: ETERNAL_AI_DEFAULT_CONTEXT_WINDOW,
        maxTokens: ETERNAL_AI_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}
