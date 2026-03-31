export { buildMistralProvider } from "./provider-catalog.js";
export {
  buildMistralModelDefinition,
  MISTRAL_BASE_URL,
  MISTRAL_DEFAULT_MODEL_ID,
} from "./model-definitions.js";
export {
  applyMistralConfig,
  applyMistralProviderConfig,
  MISTRAL_DEFAULT_MODEL_REF,
} from "./onboard.js";

const MISTRAL_MAX_TOKENS_FIELD = "max_tokens";

export const MISTRAL_MODEL_COMPAT_PATCH = {
  supportsStore: false,
  supportsReasoningEffort: false,
  maxTokensField: MISTRAL_MAX_TOKENS_FIELD,
} as const satisfies {
  supportsStore: boolean;
  supportsReasoningEffort: boolean;
  maxTokensField: "max_tokens";
};

export function applyMistralModelCompat<T extends { compat?: unknown }>(model: T): T {
  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as Record<string, unknown>)
      : undefined;
  if (
    compat &&
    Object.entries(MISTRAL_MODEL_COMPAT_PATCH).every(([key, value]) => compat[key] === value)
  ) {
    return model;
  }
  return {
    ...model,
    compat: {
      ...compat,
      ...MISTRAL_MODEL_COMPAT_PATCH,
    } as T extends { compat?: infer TCompat } ? TCompat : never,
  } as T;
}
