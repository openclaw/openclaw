import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-models";

export const PLAMO_BASE_URL = "https://api.platform.preferredai.jp/v1";
export const PLAMO_DEFAULT_MODEL_ID = "plamo-3.0-prime-beta";
export const PLAMO_DEFAULT_MODEL_REF = `plamo/${PLAMO_DEFAULT_MODEL_ID}`;
export const PLAMO_DEFAULT_CONTEXT_WINDOW = 65_536;
export const PLAMO_DEFAULT_MAX_TOKENS = 16_384;
export const PLAMO_PRICE_USD_PER_1M_INPUT = 0.375;
export const PLAMO_PRICE_USD_PER_1M_OUTPUT = 1.5625;

const PLAMO_MODEL_CATALOG = [
  {
    id: PLAMO_DEFAULT_MODEL_ID,
    name: "PLaMo 3.0 Prime Beta",
    reasoning: true,
    input: ["text"],
    // Converted from JPY pricing using a fixed 1 USD = 160 JPY assumption.
    cost: {
      input: PLAMO_PRICE_USD_PER_1M_INPUT,
      output: PLAMO_PRICE_USD_PER_1M_OUTPUT,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: PLAMO_DEFAULT_CONTEXT_WINDOW,
    maxTokens: PLAMO_DEFAULT_MAX_TOKENS,
  },
] as const satisfies readonly ModelDefinitionConfig[];

export function buildPlamoCatalogModels(): ModelDefinitionConfig[] {
  return PLAMO_MODEL_CATALOG.map((model) => ({ ...model, input: [...model.input] }));
}
