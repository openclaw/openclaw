import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
//#region src/infra/net/hostname.ts
function normalizeHostname(hostname) {
	const normalized = normalizeLowercaseStringOrEmpty(hostname).replace(/\.$/, "");
	if (normalized.startsWith("[") && normalized.endsWith("]")) return normalized.slice(1, -1);
	return normalized;
}
//#endregion
export { normalizeHostname as t };
