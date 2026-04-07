import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
// Use the canonical "openrouter/" prefix so this entry collapses with the
// pi-ai built-in `openrouter/auto` in `mergeCustomModels` (which dedupes by
// raw `provider+id` string equality). Without the prefix, both entries
// survive into the merged registry and the /models picker shows two buttons
// for the same upstream model. The other entries below (`openrouter/hunter-
// alpha`, `openrouter/healer-alpha`) are already prefixed for the same reason.
const OPENROUTER_DEFAULT_MODEL_ID = "openrouter/auto";
const OPENROUTER_DEFAULT_CONTEXT_WINDOW = 200000;
const OPENROUTER_DEFAULT_MAX_TOKENS = 8192;
const OPENROUTER_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function buildOpenrouterProvider(): ModelProviderConfig {
  return {
    baseUrl: OPENROUTER_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: OPENROUTER_DEFAULT_MODEL_ID,
        name: "OpenRouter Auto",
        reasoning: false,
        input: ["text", "image"],
        cost: OPENROUTER_DEFAULT_COST,
        contextWindow: OPENROUTER_DEFAULT_CONTEXT_WINDOW,
        maxTokens: OPENROUTER_DEFAULT_MAX_TOKENS,
      },
      {
        id: "openrouter/hunter-alpha",
        name: "Hunter Alpha",
        reasoning: true,
        input: ["text"],
        cost: OPENROUTER_DEFAULT_COST,
        contextWindow: 1048576,
        maxTokens: 65536,
      },
      {
        id: "openrouter/healer-alpha",
        name: "Healer Alpha",
        reasoning: true,
        input: ["text", "image"],
        cost: OPENROUTER_DEFAULT_COST,
        contextWindow: 262144,
        maxTokens: 65536,
      },
    ],
  };
}
