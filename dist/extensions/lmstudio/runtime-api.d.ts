import { s as ModelDefinitionConfig } from "../../types.models-tqxsISRc.js";
import { o as SsrFPolicy } from "../../ssrf-skjEI_i5.js";
import { A as LMSTUDIO_PROVIDER_LABEL, C as LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH, D as LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER, O as LMSTUDIO_MODEL_PLACEHOLDER, S as LMSTUDIO_DEFAULT_INFERENCE_BASE_URL, _ as resolveLmstudioServerBase, a as resolveLmstudioRuntimeApiKey, b as LMSTUDIO_DEFAULT_BASE_URL, h as resolveLmstudioReasoningCapability, i as resolveLmstudioRequestContext, k as LMSTUDIO_PROVIDER_ID, l as mapLmstudioWireEntry, m as resolveLmstudioInferenceBase, n as resolveLmstudioConfiguredApiKey, o as LmstudioModelBase, p as normalizeLmstudioProviderConfig, r as resolveLmstudioProviderHeaders, s as LmstudioModelWire, t as buildLmstudioAuthHeaders, u as mapLmstudioWireModelsToConfig, v as resolveLoadedContextWindow, w as LMSTUDIO_DEFAULT_MODEL_ID, x as LMSTUDIO_DEFAULT_EMBEDDING_MODEL, y as LMSTUDIO_DEFAULT_API_KEY_ENV_VAR } from "../../runtime-BPUwFkCP.js";

//#region extensions/lmstudio/src/models.fetch.d.ts
type FetchLmstudioModelsResult = {
  reachable: boolean;
  status?: number;
  models: LmstudioModelWire[];
  error?: unknown;
};
type DiscoverLmstudioModelsParams = {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  quiet: boolean; /** Injectable fetch implementation; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};
/** Fetches /api/v1/models and reports transport reachability separately from HTTP status. */
declare function fetchLmstudioModels(params: {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  timeoutMs?: number; /** Injectable fetch implementation; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}): Promise<FetchLmstudioModelsResult>;
/** Discovers LLM models from LM Studio and maps them to OpenClaw model definitions. */
declare function discoverLmstudioModels(params: DiscoverLmstudioModelsParams): Promise<ModelDefinitionConfig[]>;
/** Ensures a model is loaded in LM Studio before first real inference/embedding call. */
declare function ensureLmstudioModelLoaded(params: {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  modelKey: string;
  requestedContextLength?: number;
  timeoutMs?: number; /** Injectable fetch implementation; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}): Promise<void>;
//#endregion
export { LMSTUDIO_DEFAULT_API_KEY_ENV_VAR, LMSTUDIO_DEFAULT_BASE_URL, LMSTUDIO_DEFAULT_EMBEDDING_MODEL, LMSTUDIO_DEFAULT_INFERENCE_BASE_URL, LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH, LMSTUDIO_DEFAULT_MODEL_ID, LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER, LMSTUDIO_MODEL_PLACEHOLDER, LMSTUDIO_PROVIDER_ID, LMSTUDIO_PROVIDER_LABEL, type LmstudioModelBase, type LmstudioModelWire, buildLmstudioAuthHeaders, discoverLmstudioModels, ensureLmstudioModelLoaded, fetchLmstudioModels, mapLmstudioWireEntry, mapLmstudioWireModelsToConfig, normalizeLmstudioProviderConfig, resolveLmstudioConfiguredApiKey, resolveLmstudioInferenceBase, resolveLmstudioProviderHeaders, resolveLmstudioReasoningCapability, resolveLmstudioRequestContext, resolveLmstudioRuntimeApiKey, resolveLmstudioServerBase, resolveLoadedContextWindow };