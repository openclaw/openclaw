import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMistralReasoningEffortMap } from "./provider-policy-api.js";

export { buildMistralProvider } from "./provider-catalog.js";
export {
  buildMistralModelDefinition,
  MISTRAL_BASE_URL,
  MISTRAL_DEFAULT_MODEL_ID,
  MISTRAL_DEFAULT_MODEL_REF,
} from "./model-definitions.js";
export { applyMistralConfig, applyMistralProviderConfig } from "./onboard.js";
export {
  MISTRAL_SMALL_LATEST_ID,
  MISTRAL_SMALL_4_ID,
  MISTRAL_MEDIUM_3_5_ID,
} from "./provider-policy-api.js";

export const MISTRAL_MODEL_TRANSPORT_PATCH = {
  supportsStore: false,
  supportsPromptCacheKey: true,
  supportsLongCacheRetention: false,
  maxTokensField: "max_tokens",
} as const;

export function resolveMistralCompatPatch(model: { id?: string }): {
  supportsStore: boolean;
  supportsPromptCacheKey: boolean;
  supportsLongCacheRetention: boolean;
  supportsReasoningEffort: boolean;
  maxTokensField: "max_tokens";
  reasoningEffortMap?: Record<string, string>;
} {
  const reasoningEffortMap = resolveMistralReasoningEffortMap(model.id);
  return {
    ...MISTRAL_MODEL_TRANSPORT_PATCH,
    supportsReasoningEffort: reasoningEffortMap !== undefined,
    reasoningEffortMap,
  };
}

export function applyMistralModelCompat<T extends { compat?: unknown; id?: string }>(model: T): T {
  const compat = asOptionalObjectRecord(model.compat);
  const patch = resolveMistralCompatPatch(model);
  if (Object.entries(patch).every(([key, value]) => compat?.[key] === value)) {
    return model;
  }
  return {
    ...model,
    compat: { ...compat, ...patch },
  };
}
