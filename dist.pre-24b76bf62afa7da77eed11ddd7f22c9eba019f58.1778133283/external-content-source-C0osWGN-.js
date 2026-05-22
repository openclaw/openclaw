import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
//#region src/security/external-content-source.ts
function resolveHookExternalContentSource(sessionKey) {
	const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
	if (normalized.startsWith("hook:gmail:")) return "gmail";
	if (normalized.startsWith("hook:webhook:") || normalized.startsWith("hook:")) return "webhook";
}
function mapHookExternalContentSource(source) {
	return source === "gmail" ? "email" : "webhook";
}
function isExternalHookSession(sessionKey) {
	return resolveHookExternalContentSource(sessionKey) !== void 0;
}
//#endregion
export { mapHookExternalContentSource as n, resolveHookExternalContentSource as r, isExternalHookSession as t };
