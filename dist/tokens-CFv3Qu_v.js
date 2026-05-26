import { b as escapeRegExp } from "./utils-sBTEdeml.js";
//#region src/auto-reply/tokens.ts
const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
const SILENT_REPLY_TOKEN = "NO_REPLY";
const silentExactRegexByToken = /* @__PURE__ */ new Map();
const silentTrailingRegexByToken = /* @__PURE__ */ new Map();
const silentLeadingAttachedRegexByToken = /* @__PURE__ */ new Map();
function getSilentExactRegex(token) {
	const cached = silentExactRegexByToken.get(token);
	if (cached) return cached;
	const escaped = escapeRegExp(token);
	const regex = new RegExp(`^\\s*${escaped}\\s*$`, "i");
	silentExactRegexByToken.set(token, regex);
	return regex;
}
function getSilentTrailingRegex(token) {
	const cached = silentTrailingRegexByToken.get(token);
	if (cached) return cached;
	const escaped = escapeRegExp(token);
	const regex = new RegExp(`(?:^|\\s+|\\*+)${escaped}\\s*$`, "i");
	silentTrailingRegexByToken.set(token, regex);
	return regex;
}
function isSilentReplyText(text, token = SILENT_REPLY_TOKEN) {
	if (!text) return false;
	return getSilentExactRegex(token).test(text);
}
function isSilentReplyEnvelopeText(text, token = SILENT_REPLY_TOKEN) {
	if (!text) return false;
	const trimmed = text.trim();
	if (!trimmed || !trimmed.startsWith("{") || !trimmed.endsWith("}") || !trimmed.includes(token)) return false;
	try {
		const parsed = JSON.parse(trimmed);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
		const keys = Object.keys(parsed);
		return keys.length === 1 && keys[0] === "action" && typeof parsed.action === "string" && parsed.action.trim() === token;
	} catch {
		return false;
	}
}
function isSilentReplyPayloadText(text, token = SILENT_REPLY_TOKEN) {
	return isSilentReplyText(text, token) || isSilentReplyEnvelopeText(text, token);
}
/**
* Strip a trailing silent reply token from mixed-content text.
* Returns the remaining text with the token removed (trimmed).
* If the result is empty, the entire message should be treated as silent.
*/
function stripSilentToken(text, token = SILENT_REPLY_TOKEN) {
	return text.replace(getSilentTrailingRegex(token), "").trim();
}
const silentLeadingRegexByToken = /* @__PURE__ */ new Map();
function getSilentLeadingAttachedRegex(token) {
	const cached = silentLeadingAttachedRegexByToken.get(token);
	if (cached) return cached;
	const escaped = escapeRegExp(token);
	const regex = new RegExp(`^\\s*(?:${escaped}\\s+)*${escaped}(?=[\\p{L}\\p{N}])`, "iu");
	silentLeadingAttachedRegexByToken.set(token, regex);
	return regex;
}
function getSilentLeadingRegex(token) {
	const cached = silentLeadingRegexByToken.get(token);
	if (cached) return cached;
	const escaped = escapeRegExp(token);
	const regex = new RegExp(`^(?:\\s*${escaped})+\\s*`, "i");
	silentLeadingRegexByToken.set(token, regex);
	return regex;
}
/**
* Strip leading silent reply tokens from text.
* Handles cases like "NO_REPLYThe user is saying..." where the token
* is not separated from the following text.
*/
function stripLeadingSilentToken(text, token = SILENT_REPLY_TOKEN) {
	return text.replace(getSilentLeadingRegex(token), "").trim();
}
/**
* Check whether text starts with one or more leading silent reply tokens where
* the final token is glued directly to visible content.
*/
function startsWithSilentToken(text, token = SILENT_REPLY_TOKEN) {
	if (!text) return false;
	return getSilentLeadingAttachedRegex(token).test(text);
}
function isSilentReplyPrefixText(text, token = SILENT_REPLY_TOKEN) {
	if (!text) return false;
	const trimmed = text.trimStart();
	if (!trimmed) return false;
	if (trimmed !== trimmed.toUpperCase()) return false;
	const normalized = trimmed.toUpperCase();
	if (!normalized) return false;
	if (normalized.length < 2) return false;
	if (/[^A-Z_]/.test(normalized)) return false;
	const tokenUpper = token.toUpperCase();
	if (!tokenUpper.startsWith(normalized)) return false;
	if (normalized.includes("_")) return true;
	return tokenUpper === "NO_REPLY" && normalized === "NO";
}
//#endregion
export { isSilentReplyText as a, stripSilentToken as c, isSilentReplyPrefixText as i, SILENT_REPLY_TOKEN as n, startsWithSilentToken as o, isSilentReplyPayloadText as r, stripLeadingSilentToken as s, HEARTBEAT_TOKEN as t };
