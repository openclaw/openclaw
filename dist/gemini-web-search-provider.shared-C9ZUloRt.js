import { r as normalizeGoogleApiBaseUrl } from "./provider-policy-C3QGAGLZ.js";
//#region extensions/google/src/gemini-web-search-provider.shared.ts
const DEFAULT_GEMINI_WEB_SEARCH_MODEL = "gemini-2.5-flash";
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function trimToUndefined(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function resolveGeminiConfig(searchConfig) {
	const gemini = searchConfig?.gemini;
	return isRecord(gemini) ? gemini : {};
}
function resolveGeminiModel(gemini) {
	return trimToUndefined(gemini?.model) ?? DEFAULT_GEMINI_WEB_SEARCH_MODEL;
}
function resolveGeminiBaseUrl(gemini) {
	return normalizeGoogleApiBaseUrl(trimToUndefined(gemini?.baseUrl) ?? trimToUndefined(gemini?.providerBaseUrl));
}
//#endregion
export { resolveGeminiConfig as n, resolveGeminiModel as r, resolveGeminiBaseUrl as t };
