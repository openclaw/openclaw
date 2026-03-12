import { Z as escapeRegExp } from "./entry.js";

//#region src/auto-reply/tokens.ts
const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
const SILENT_REPLY_TOKEN = "NO_REPLY";
function isSilentReplyText(text, token = SILENT_REPLY_TOKEN) {
	if (!text) return false;
	const escaped = escapeRegExp(token);
	return new RegExp(`^\\s*${escaped}\\s*$`).test(text);
}
function isSilentReplyPrefixText(text, token = SILENT_REPLY_TOKEN) {
	if (!text) return false;
	const normalized = text.trimStart().toUpperCase();
	if (!normalized) return false;
	if (!normalized.includes("_")) return false;
	if (/[^A-Z_]/.test(normalized)) return false;
	return token.toUpperCase().startsWith(normalized);
}

//#endregion
export { isSilentReplyText as i, SILENT_REPLY_TOKEN as n, isSilentReplyPrefixText as r, HEARTBEAT_TOKEN as t };