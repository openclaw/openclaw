import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
//#region src/infra/tls/fingerprint.ts
function normalizeFingerprint(input) {
	return normalizeLowercaseStringOrEmpty(input.trim().replace(/^sha-?256\s*:?\s*/i, "").replace(/[^a-fA-F0-9]/g, ""));
}
//#endregion
export { normalizeFingerprint as t };
