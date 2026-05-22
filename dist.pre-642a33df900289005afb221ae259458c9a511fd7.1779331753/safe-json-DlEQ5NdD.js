import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { n as estimateBase64DecodedBytes } from "./base64-D03BM6T6.js";
import crypto from "node:crypto";
//#region src/agents/payload-redaction.ts
const REDACTED_IMAGE_DATA = "<redacted>";
const NON_CREDENTIAL_FIELD_NAMES = new Set([
	"passwordfile",
	"tokenbudget",
	"tokencount",
	"tokenfield",
	"tokenlimit",
	"tokens"
]);
const AUTHORIZATION_VALUE_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9+/._~=-]{8,}/giu;
const JWT_VALUE_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu;
const COOKIE_PAIR_RE = /\b([A-Za-z][A-Za-z0-9_.-]{1,64})=([A-Za-z0-9+/._~%=-]{16,})(?=;|\s|$)/gu;
function normalizeFieldName(value) {
	return normalizeLowercaseStringOrEmpty(value.replaceAll(/[^a-z0-9]/gi, ""));
}
function isCredentialFieldName(key) {
	const normalized = normalizeFieldName(key);
	if (!normalized || NON_CREDENTIAL_FIELD_NAMES.has(normalized)) return false;
	if (normalized === "authorization" || normalized === "proxyauthorization") return true;
	return normalized.endsWith("apikey") || normalized.endsWith("password") || normalized.endsWith("passwd") || normalized.endsWith("passphrase") || normalized.endsWith("secret") || normalized.endsWith("secretkey") || normalized.endsWith("token");
}
function redactSensitivePayloadString(value) {
	return value.replace(AUTHORIZATION_VALUE_RE, "$1 <redacted>").replace(JWT_VALUE_RE, "<redacted-jwt>").replace(COOKIE_PAIR_RE, "$1=<redacted>");
}
function hasSensitiveNameValuePair(record) {
	const rawName = typeof record.name === "string" ? record.name : record.key;
	return typeof rawName === "string" && isCredentialFieldName(rawName);
}
function hasImageMime(record) {
	return [
		normalizeLowercaseStringOrEmpty(record.mimeType),
		normalizeLowercaseStringOrEmpty(record.media_type),
		normalizeLowercaseStringOrEmpty(record.mime_type)
	].some((value) => value.startsWith("image/"));
}
function shouldRedactImageData(record) {
	if (typeof record.data !== "string") return false;
	return normalizeLowercaseStringOrEmpty(record.type) === "image" || hasImageMime(record);
}
function digestBase64Payload(data) {
	return crypto.createHash("sha256").update(data).digest("hex");
}
function visitDiagnosticPayload(value, opts) {
	const seen = /* @__PURE__ */ new WeakSet();
	const visit = (input) => {
		if (Array.isArray(input)) return input.map((entry) => visit(entry));
		if (typeof input === "string") return redactSensitivePayloadString(input);
		if (!input || typeof input !== "object") return input;
		if (seen.has(input)) return "[Circular]";
		seen.add(input);
		const record = input;
		const out = {};
		const redactValueField = hasSensitiveNameValuePair(record);
		for (const [key, val] of Object.entries(record)) {
			if (opts?.omitField?.(key)) continue;
			out[key] = redactValueField && key === "value" ? "<redacted>" : visit(val);
		}
		if (shouldRedactImageData(record)) {
			out.data = REDACTED_IMAGE_DATA;
			out.bytes = estimateBase64DecodedBytes(record.data);
			out.sha256 = digestBase64Payload(record.data);
		}
		return out;
	};
	return visit(value);
}
/**
* Removes credential-like fields and image/base64 payload data from diagnostic
* objects before persistence.
*/
function sanitizeDiagnosticPayload(value) {
	return visitDiagnosticPayload(value, { omitField: isCredentialFieldName });
}
//#endregion
//#region src/utils/safe-json.ts
function safeJsonStringify(value) {
	try {
		return JSON.stringify(value, (_key, val) => {
			if (typeof val === "bigint") return val.toString();
			if (typeof val === "function") return "[Function]";
			if (val instanceof Error) return {
				name: val.name,
				message: val.message,
				stack: val.stack
			};
			if (val instanceof Uint8Array) return {
				type: "Uint8Array",
				data: Buffer.from(val).toString("base64")
			};
			return val;
		});
	} catch {
		return null;
	}
}
//#endregion
export { sanitizeDiagnosticPayload as n, safeJsonStringify as t };
