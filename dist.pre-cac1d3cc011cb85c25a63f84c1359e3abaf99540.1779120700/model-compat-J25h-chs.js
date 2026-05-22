import { t as applyModelCompatPatch } from "./provider-model-compat-uGbgEKb-.js";
import "./provider-model-shared-C6eabFrb.js";
//#region extensions/xai/model-compat.ts
const XAI_TOOL_SCHEMA_PROFILE = "xai";
const HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING = "html-entities";
const XAI_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
	"minLength",
	"maxLength",
	"minItems",
	"maxItems",
	"minContains",
	"maxContains"
]);
function resolveXaiModelCompatPatch() {
	return {
		toolSchemaProfile: "xai",
		unsupportedToolSchemaKeywords: Array.from(XAI_UNSUPPORTED_SCHEMA_KEYWORDS),
		nativeWebSearchTool: true,
		toolCallArgumentsEncoding: HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING
	};
}
function applyXaiModelCompat(model) {
	return applyModelCompatPatch(model, resolveXaiModelCompatPatch());
}
//#endregion
export { resolveXaiModelCompatPatch as a, applyXaiModelCompat as i, XAI_TOOL_SCHEMA_PROFILE as n, XAI_UNSUPPORTED_SCHEMA_KEYWORDS as r, HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING as t };
