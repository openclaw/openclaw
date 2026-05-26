import { t as applyModelCompatPatch } from "./provider-model-compat-Dk5etUbu.js";
import "./provider-model-shared-D-slKnZa.js";
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
function normalizeNativeXaiModelId(id) {
	if (id === "grok-4-fast-reasoning") return "grok-4-fast";
	if (id === "grok-4-1-fast-reasoning") return "grok-4-1-fast";
	if (id === "grok-4.20-experimental-beta-0304-reasoning") return "grok-4.20-beta-latest-reasoning";
	if (id === "grok-4.20-experimental-beta-0304-non-reasoning") return "grok-4.20-beta-latest-non-reasoning";
	if (id === "grok-4.20-reasoning") return "grok-4.20-beta-latest-reasoning";
	if (id === "grok-4.20-non-reasoning") return "grok-4.20-beta-latest-non-reasoning";
	return id;
}
//#endregion
export { normalizeNativeXaiModelId as a, applyXaiModelCompat as i, XAI_TOOL_SCHEMA_PROFILE as n, resolveXaiModelCompatPatch as o, XAI_UNSUPPORTED_SCHEMA_KEYWORDS as r, HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING as t };
