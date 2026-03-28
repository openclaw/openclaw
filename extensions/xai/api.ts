import { applyModelCompatPatch } from "openclaw/plugin-sdk/provider-model-shared";
import type { ModelCompatConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { XAI_UNSUPPORTED_SCHEMA_KEYWORDS } from "openclaw/plugin-sdk/provider-tools";

export { buildXaiProvider } from "./provider-catalog.js";
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
export { normalizeXaiModelId } from "./model-id.js";

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
