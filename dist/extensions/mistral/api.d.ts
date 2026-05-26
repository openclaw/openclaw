import { t as buildMistralProvider } from "../../provider-catalog-Cek8msK3.js";
import { a as MISTRAL_DEFAULT_MODEL_ID, s as buildMistralModelDefinition, t as MISTRAL_BASE_URL } from "../../model-definitions-BhoAZUv4.js";
import { n as applyMistralConfig, r as applyMistralProviderConfig, t as MISTRAL_DEFAULT_MODEL_REF } from "../../onboard-DjWoj-r1.js";

//#region extensions/mistral/api.d.ts
declare const MISTRAL_MODEL_TRANSPORT_PATCH: {
  readonly supportsStore: false;
  readonly maxTokensField: "max_tokens";
};
declare const MISTRAL_SMALL_LATEST_ID = "mistral-small-latest";
declare const MISTRAL_MEDIUM_3_5_ID = "mistral-medium-3-5";
declare function resolveMistralCompatPatch(model: {
  id?: string;
}): {
  supportsStore: boolean;
  supportsReasoningEffort: boolean;
  maxTokensField: "max_tokens";
  reasoningEffortMap?: Record<string, string>;
};
declare function applyMistralModelCompat<T extends {
  compat?: unknown;
  id?: string;
}>(model: T): T;
//#endregion
export { MISTRAL_BASE_URL, MISTRAL_DEFAULT_MODEL_ID, MISTRAL_DEFAULT_MODEL_REF, MISTRAL_MEDIUM_3_5_ID, MISTRAL_MODEL_TRANSPORT_PATCH, MISTRAL_SMALL_LATEST_ID, applyMistralConfig, applyMistralModelCompat, applyMistralProviderConfig, buildMistralModelDefinition, buildMistralProvider, resolveMistralCompatPatch };