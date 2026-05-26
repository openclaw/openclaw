import { a as isSilentReplyText, n as SILENT_REPLY_TOKEN } from "./tokens-CFv3Qu_v.js";
//#region src/gateway/control-reply-text.ts
const SUPPRESSED_CONTROL_REPLY_TOKENS = [
	SILENT_REPLY_TOKEN,
	"ANNOUNCE_SKIP",
	"REPLY_SKIP"
];
const MIN_BARE_PREFIX_LENGTH_BY_TOKEN = {
	[SILENT_REPLY_TOKEN]: 2,
	ANNOUNCE_SKIP: 3,
	REPLY_SKIP: 3
};
function normalizeSuppressedControlReplyFragment(text) {
	const trimmed = text.trim();
	if (!trimmed) return "";
	const normalized = trimmed.toUpperCase();
	if (/[^A-Z_]/.test(normalized)) return "";
	return normalized;
}
/**
* Return true when a chat-visible reply is exactly an internal control token.
*/
function isSuppressedControlReplyText(text) {
	const normalized = text.trim();
	return SUPPRESSED_CONTROL_REPLY_TOKENS.some((token) => isSilentReplyText(normalized, token));
}
/**
* Return true when streamed assistant text looks like the leading fragment of a control token.
*/
function isSuppressedControlReplyLeadFragment(text) {
	const trimmed = text.trim();
	const normalized = normalizeSuppressedControlReplyFragment(text);
	if (!normalized) return false;
	return SUPPRESSED_CONTROL_REPLY_TOKENS.some((token) => {
		const tokenUpper = token.toUpperCase();
		if (normalized === tokenUpper) return false;
		if (!tokenUpper.startsWith(normalized)) return false;
		if (normalized.includes("_")) return true;
		if (token !== "NO_REPLY" && trimmed !== trimmed.toUpperCase()) return false;
		return normalized.length >= MIN_BARE_PREFIX_LENGTH_BY_TOKEN[token];
	});
}
//#endregion
export { isSuppressedControlReplyText as n, isSuppressedControlReplyLeadFragment as t };
