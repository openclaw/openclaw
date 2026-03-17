import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-models";

export const XAI_BASE_URL = "https://api.x.ai/v1";
export const XAI_DEFAULT_MODEL_ID = "grok-4";
export const XAI_DEFAULT_MODEL_REF = `xai/${XAI_DEFAULT_MODEL_ID}`;
export const XAI_DEFAULT_CONTEXT_WINDOW = 131072;
export const XAI_DEFAULT_MAX_TOKENS = 8192;
export const XAI_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function buildXaiModelDefinition(): ModelDefinitionConfig {
  return {
    id: XAI_DEFAULT_MODEL_ID,
    name: "Grok 4",
    reasoning: false,
    input: ["text"],
    cost: XAI_DEFAULT_COST,
    contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: XAI_DEFAULT_MAX_TOKENS,
  };
}
