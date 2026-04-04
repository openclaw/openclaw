import {
  applyModelCompatPatch,
  getModelProviderHint,
  normalizeNativeXaiModelId,
  normalizeProviderId,
  resolveProviderEndpoint,
} from "openclaw/plugin-sdk/provider-model-shared";
import type { ModelCompatConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { XAI_UNSUPPORTED_SCHEMA_KEYWORDS } from "openclaw/plugin-sdk/provider-tools";

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
export const XAI_TOOL_SCHEMA_PROFILE = "xai";
export const HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING = "html-entities";

export function resolveXaiModelCompatPatch(): ModelCompatConfig {
  return {
    toolSchemaProfile: XAI_TOOL_SCHEMA_PROFILE,
    unsupportedToolSchemaKeywords: Array.from(XAI_UNSUPPORTED_SCHEMA_KEYWORDS),
    nativeWebSearchTool: true,
    toolCallArgumentsEncoding: HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING,
  };
}

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
