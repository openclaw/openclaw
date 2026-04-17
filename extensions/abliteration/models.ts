import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

// Anthropic-compatible providers store the API origin without /v1.
export const ABLITERATION_BASE_URL = "https://api.abliteration.ai";
export const ABLITERATION_DEFAULT_MODEL_ID = "abliterated-model";
export const ABLITERATION_DEFAULT_MODEL_REF = `abliteration/${ABLITERATION_DEFAULT_MODEL_ID}`;
export const ABLITERATION_DEFAULT_COST = {
  input: 5,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
};

export const ABLITERATION_MODEL_CATALOG = [
  {
    id: ABLITERATION_DEFAULT_MODEL_ID,
    name: "Abliterated Model",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 8192,
  },
] as const;

export type AbliterationCatalogEntry = (typeof ABLITERATION_MODEL_CATALOG)[number];

export function buildAbliterationModelDefinition(
  entry: AbliterationCatalogEntry,
): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: ABLITERATION_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}
