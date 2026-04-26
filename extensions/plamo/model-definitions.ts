import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const PLAMO_BASE_URL = "https://api.platform.preferredai.jp/v1";
export const PLAMO_DEFAULT_MODEL_ID = "plamo-3.0-prime-beta";
export const PLAMO_DEFAULT_MODEL_REF = `plamo/${PLAMO_DEFAULT_MODEL_ID}`;
export const PLAMO_DEFAULT_CONTEXT_WINDOW = 65_536;
export const PLAMO_DEFAULT_MAX_TOKENS = 20_000;
export const PLAMO_PRICE_USD_PER_1M_INPUT = 0.375;
export const PLAMO_PRICE_USD_PER_1M_OUTPUT = 1.5625;
export const PLAMO_MODEL_INPUT = ["text"] as const;

export const PLAMO_OPENAI_COMPAT = {
  // PLaMo's Chat Completions reference documents only `system`/`user`/`assistant`
  // roles, `max_tokens`, and the legacy tool schema without `strict`/`store`.
  maxTokensField: "max_tokens",
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsStore: false,
  supportsStrictMode: false,
} as const satisfies NonNullable<ModelDefinitionConfig["compat"]>;

const PLAMO_MODEL_CATALOG = [
  {
    id: PLAMO_DEFAULT_MODEL_ID,
    name: "PLaMo 3.0 Prime Beta",
    // PLaMo returns `reasoning_content`, but the public API does not expose a
    // request-side reasoning toggle. In OpenClaw, `reasoning: true` means "the
    // caller can opt into provider-controlled reasoning mode", so keep this
    // false and treat the streamed reasoning payload as an always-on side
    // channel instead.
    reasoning: false,
    input: [...PLAMO_MODEL_INPUT],
    // Converted from JPY pricing using a fixed 1 USD = 160 JPY assumption.
    cost: {
      input: PLAMO_PRICE_USD_PER_1M_INPUT,
      output: PLAMO_PRICE_USD_PER_1M_OUTPUT,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: PLAMO_DEFAULT_CONTEXT_WINDOW,
    maxTokens: PLAMO_DEFAULT_MAX_TOKENS,
    compat: PLAMO_OPENAI_COMPAT,
  },
] as const satisfies readonly ModelDefinitionConfig[];

export function buildPlamoCatalogModels(): ModelDefinitionConfig[] {
  return PLAMO_MODEL_CATALOG.map((model) => Object.assign({}, model, { input: [...model.input] }));
}
