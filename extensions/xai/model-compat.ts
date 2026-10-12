import {
  applyModelCompatPatch,
  type ModelCompatConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

export { normalizeXaiModelId as normalizeNativeXaiModelId } from "./model-id.js";

export const XAI_TOOL_SCHEMA_PROFILE = "xai";
export const HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING = "html-entities";

// Native xAI accepts common length/item bounds; only contains-count bounds remain
// outside its documented schema contract. Proxy providers own stricter downstream policy.
export function applyXaiModelCompat<T extends { compat?: unknown }>(model: T): T {
  return applyModelCompatPatch(model as T & { compat?: ModelCompatConfig }, {
    toolSchemaProfile: XAI_TOOL_SCHEMA_PROFILE,
    unsupportedToolSchemaKeywords: ["minContains", "maxContains"],
    toolCallArgumentsEncoding: HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING,
  }) as T;
}
