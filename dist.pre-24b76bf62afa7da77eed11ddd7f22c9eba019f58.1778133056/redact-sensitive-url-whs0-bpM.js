import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
//#region src/shared/net/redact-sensitive-url.ts
const SENSITIVE_URL_HINT_TAG = "url-secret";
const SENSITIVE_URL_QUERY_PARAM_NAMES = new Set([
	"token",
	"key",
	"api_key",
	"apikey",
	"secret",
	"access_token",
	"auth_token",
	"password",
	"pass",
	"passwd",
	"auth",
	"client_secret",
	"hook_token",
	"refresh_token",
	"signature"
]);
function isSensitiveUrlQueryParamName(name) {
	const normalized = normalizeLowercaseStringOrEmpty(name).replaceAll("-", "_");
	return SENSITIVE_URL_QUERY_PARAM_NAMES.has(normalized);
}
function isSensitiveUrlConfigPath(path) {
	if (path.endsWith(".baseUrl") || path.endsWith(".httpUrl")) return true;
	if (path.endsWith(".cdpUrl")) return true;
	if (path.endsWith(".request.proxy.url")) return true;
	return /^mcp\.servers\.(?:\*|[^.]+)\.url$/.test(path);
}
function hasSensitiveUrlHintTag(hint) {
	return hint?.tags?.includes(SENSITIVE_URL_HINT_TAG) === true;
}
function redactSensitiveUrl(value) {
	try {
		const parsed = new URL(value);
		let mutated = false;
		if (parsed.username || parsed.password) {
			parsed.username = parsed.username ? "***" : "";
			parsed.password = parsed.password ? "***" : "";
			mutated = true;
		}
		for (const key of Array.from(parsed.searchParams.keys())) if (isSensitiveUrlQueryParamName(key)) {
			parsed.searchParams.set(key, "***");
			mutated = true;
		}
		return mutated ? parsed.toString() : value;
	} catch {
		return value;
	}
}
function redactSensitiveUrlLikeString(value) {
	const redactedUrl = redactSensitiveUrl(value);
	if (redactedUrl !== value) return redactedUrl;
	return value.replace(/\/\/([^@/?#\s]+)@/g, "//***:***@").replace(/([?&])([^=&]+)=([^&]*)/g, (match, prefix, key) => isSensitiveUrlQueryParamName(key) ? `${prefix}${key}=***` : match);
}
//#endregion
export { redactSensitiveUrl as a, isSensitiveUrlQueryParamName as i, hasSensitiveUrlHintTag as n, redactSensitiveUrlLikeString as o, isSensitiveUrlConfigPath as r, SENSITIVE_URL_HINT_TAG as t };
