import { c as normalizeOptionalString, p as resolvePrimaryStringValue } from "./string-coerce-Bje8XVt9.js";
//#region src/config/model-input.ts
function resolveAgentModelPrimaryValue(model) {
	return resolvePrimaryStringValue(model);
}
function resolveAgentModelFallbackValues(model) {
	if (!model || typeof model !== "object") return [];
	return Array.isArray(model.fallbacks) ? model.fallbacks : [];
}
function resolveAgentModelTimeoutMsValue(model) {
	if (!model || typeof model !== "object") return;
	return typeof model.timeoutMs === "number" && Number.isFinite(model.timeoutMs) && model.timeoutMs > 0 ? Math.floor(model.timeoutMs) : void 0;
}
function toAgentModelListLike(model) {
	if (typeof model === "string") {
		const primary = normalizeOptionalString(model);
		return primary ? { primary } : void 0;
	}
	if (!model || typeof model !== "object") return;
	return model;
}
//#endregion
export { toAgentModelListLike as i, resolveAgentModelPrimaryValue as n, resolveAgentModelTimeoutMsValue as r, resolveAgentModelFallbackValues as t };
