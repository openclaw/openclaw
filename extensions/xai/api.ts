import {
  applyModelCompatPatch,
  getModelProviderHint,
  normalizeNativeXaiModelId,
  normalizeProviderId,
  resolveProviderEndpoint,
} from "openclaw/plugin-sdk/provider-model-shared";
import type { ModelCompatConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { resolveXaiModelCompatPatch } from "openclaw/plugin-sdk/provider-tools";

export { buildXaiProvider } from "./provider-catalog.js";
export { applyXaiConfig, applyXaiProviderConfig } from "./onboard.js";
export {
  buildXaiCatalogModels,
  buildXaiModelDefinition,
  resolveXaiCatalogEntry,
  XAI_BASE_URL,
  XAI_DEFAULT_CONTEXT_WINDOW,
  XAI_DEFAULT_MODEL_ID,
  XAI_DEFAULT_MODEL_REF,
  XAI_DEFAULT_MAX_TOKENS,
} from "./model-definitions.js";
export { isModernXaiModel, resolveXaiForwardCompatModel } from "./provider-models.js";
export {
  HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING,
  XAI_TOOL_SCHEMA_PROFILE,
  resolveXaiModelCompatPatch,
} from "openclaw/plugin-sdk/provider-tools";

export function applyXaiModelCompat<T extends { compat?: unknown }>(model: T): T {
  return applyModelCompatPatch(
    model as T & { compat?: ModelCompatConfig },
    resolveXaiModelCompatPatch(),
  ) as T;
}

function isXaiNativeEndpoint(baseUrl: unknown): boolean {
  return (
    typeof baseUrl === "string" && resolveProviderEndpoint(baseUrl).endpointClass === "xai-native"
  );
}

export function isXaiModelHint(modelId: string): boolean {
  return getModelProviderHint(modelId) === "x-ai";
}

export { normalizeNativeXaiModelId as normalizeXaiModelId };

function shouldUseXaiResponsesTransport(params: {
  provider: string;
  api?: unknown;
  baseUrl?: unknown;
}): boolean {
  if (params.api !== "openai-completions") {
    return false;
  }
  if (isXaiNativeEndpoint(params.baseUrl)) {
    return true;
  }
  return normalizeProviderId(params.provider) === "xai" && !params.baseUrl;
}

export function shouldContributeXaiCompat(params: {
  modelId: string;
  model: { api?: unknown; baseUrl?: unknown };
}): boolean {
  if (params.model.api !== "openai-completions") {
    return false;
  }
  return isXaiNativeEndpoint(params.model.baseUrl) || isXaiModelHint(params.modelId);
}

export function resolveXaiTransport(params: {
  provider: string;
  api?: unknown;
  baseUrl?: unknown;
}): { api: "openai-responses"; baseUrl?: string } | undefined {
  if (!shouldUseXaiResponsesTransport(params)) {
    return undefined;
  }
  return {
    api: "openai-responses",
    baseUrl: typeof params.baseUrl === "string" ? params.baseUrl : undefined,
  };
}
