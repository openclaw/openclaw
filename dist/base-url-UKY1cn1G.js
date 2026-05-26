import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
//#region extensions/openai/base-url.ts
const OPENAI_CODEX_RESPONSES_BASE_URL = "https://chatgpt.com/backend-api/codex";
function isOpenAIApiBaseUrl(baseUrl) {
	const trimmed = normalizeOptionalString(baseUrl);
	if (!trimmed) return false;
	return /^https?:\/\/api\.openai\.com(?:\/v1)?\/?$/i.test(trimmed);
}
function isOpenAICodexBaseUrl(baseUrl) {
	const trimmed = normalizeOptionalString(baseUrl);
	if (!trimmed) return false;
	return /^https?:\/\/chatgpt\.com\/backend-api(?:\/codex)?(?:\/v1)?\/?$/i.test(trimmed);
}
function canonicalizeCodexResponsesBaseUrl(baseUrl) {
	return isOpenAICodexBaseUrl(baseUrl) ? OPENAI_CODEX_RESPONSES_BASE_URL : baseUrl;
}
//#endregion
export { isOpenAICodexBaseUrl as i, canonicalizeCodexResponsesBaseUrl as n, isOpenAIApiBaseUrl as r, OPENAI_CODEX_RESPONSES_BASE_URL as t };
