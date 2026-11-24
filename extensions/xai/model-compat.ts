import {
  applyModelCompatPatch,
  XAI_TOOL_MODEL_COMPAT,
  type ModelCompatConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

export { normalizeXaiModelId as normalizeNativeXaiModelId } from "./model-id.js";

export const XAI_TOOL_SCHEMA_PROFILE = XAI_TOOL_MODEL_COMPAT.toolSchemaProfile;
export const HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING =
  XAI_TOOL_MODEL_COMPAT.toolCallArgumentsEncoding;

// Native xAI accepts common length/item bounds; only contains-count bounds remain
// outside its documented schema contract. Proxy providers own stricter downstream policy.
export function applyXaiModelCompat<T extends { compat?: ModelCompatConfig }>(model: T): T {
  return applyModelCompatPatch(model, XAI_TOOL_MODEL_COMPAT);
}
