import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
//#region extensions/openrouter/models.ts
function normalizeOpenRouterModelId(modelId) {
	if (typeof modelId !== "string") return;
	const normalized = normalizeLowercaseStringOrEmpty(modelId);
	return normalized.startsWith("openrouter/") ? normalized.slice(11) : normalized;
}
function isOpenRouterDeepSeekV4ModelId(modelId) {
	const normalized = normalizeOpenRouterModelId(modelId);
	if (!normalized?.startsWith("deepseek/")) return false;
	const deepSeekModelId = normalized.slice(9).split(":", 1)[0];
	return deepSeekModelId === "deepseek-v4-flash" || deepSeekModelId === "deepseek-v4-pro";
}
//#endregion
export { normalizeOpenRouterModelId as n, isOpenRouterDeepSeekV4ModelId as t };
