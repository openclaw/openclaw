import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { r as normalizeCommandBody } from "./commands-registry-normalize-D5KpdXj-.js";
import "./commands-registry-CPSWhUW1.js";
//#region src/auto-reply/reply/btw-command.ts
const BTW_COMMAND_RE = /^\/btw(?::|\s|$)/i;
function isBtwRequestText(text, options) {
	if (!text) return false;
	const normalized = normalizeCommandBody(text, options).trim();
	return BTW_COMMAND_RE.test(normalized);
}
function extractBtwQuestion(text, options) {
	if (!text) return null;
	const match = normalizeCommandBody(text, options).trim().match(/^\/btw(?:\s+(.*))?$/i);
	if (!match) return null;
	return normalizeOptionalString(match[1]) ?? "";
}
//#endregion
export { isBtwRequestText as n, extractBtwQuestion as t };
