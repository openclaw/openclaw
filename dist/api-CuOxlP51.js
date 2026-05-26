import "./provider-catalog-wn341Uo6.js";
import "./models-DafvOE9o.js";
//#region extensions/volcengine/api.ts
const VOLCENGINE_UNSUPPORTED_TOOL_SCHEMA_KEYWORDS = [
	"minLength",
	"maxLength",
	"minItems",
	"maxItems",
	"minContains",
	"maxContains"
];
function mergeUnsupportedToolSchemaKeywords(existing) {
	return Array.from(new Set([...existing ?? [], ...VOLCENGINE_UNSUPPORTED_TOOL_SCHEMA_KEYWORDS]));
}
function resolveVolcengineToolSchemaCompatPatch(compat) {
	return { unsupportedToolSchemaKeywords: mergeUnsupportedToolSchemaKeywords(compat?.unsupportedToolSchemaKeywords) };
}
function applyVolcengineToolSchemaCompat(model) {
	const unsupportedToolSchemaKeywords = mergeUnsupportedToolSchemaKeywords(model.compat?.unsupportedToolSchemaKeywords);
	if (model.compat?.unsupportedToolSchemaKeywords?.length === unsupportedToolSchemaKeywords.length && unsupportedToolSchemaKeywords.every((keyword, index) => model.compat?.unsupportedToolSchemaKeywords?.[index] === keyword)) return model;
	return {
		...model,
		compat: {
			...model.compat,
			unsupportedToolSchemaKeywords
		}
	};
}
//#endregion
export { applyVolcengineToolSchemaCompat as n, resolveVolcengineToolSchemaCompatPatch as r, VOLCENGINE_UNSUPPORTED_TOOL_SCHEMA_KEYWORDS as t };
