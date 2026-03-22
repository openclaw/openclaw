import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-models";

export const MISTRAL_BASE_URL = "https://api.mistral.ai/v1";
export const MISTRAL_DEFAULT_MODEL_ID = "mistral-large-latest";
export const MISTRAL_DEFAULT_MODEL_REF = `mistral/${MISTRAL_DEFAULT_MODEL_ID}`;
export const MISTRAL_DEFAULT_CONTEXT_WINDOW = 262144;
export const MISTRAL_DEFAULT_MAX_TOKENS = 262144;
export const MISTRAL_DEFAULT_COST = {
  input: 0.5,
  output: 1.5,
  cacheRead: 0,
  cacheWrite: 0,
};

export function buildMistralModelDefinition(): ModelDefinitionConfig {
  return {
    id: MISTRAL_DEFAULT_MODEL_ID,
    name: "Mistral Large",
    reasoning: false,
    input: ["text", "image"],
    cost: MISTRAL_DEFAULT_COST,
    contextWindow: MISTRAL_DEFAULT_CONTEXT_WINDOW,
    maxTokens: MISTRAL_DEFAULT_MAX_TOKENS,
  };
}
