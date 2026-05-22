import { i as redactSensitiveText, s as resolveRedactOptions } from "./redact-1fZUZMlV.js";
//#region src/infra/exec-approval-command-display.ts
const EXEC_APPROVAL_INVISIBLE_CHAR_REGEX = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0]/gu;
const EXEC_APPROVAL_INVISIBLE_CHAR_SINGLE = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0]$/u;
const EXEC_APPROVAL_MAX_INPUT = 256 * 1024;
const EXEC_APPROVAL_MAX_OUTPUT = 16 * 1024;
const EXEC_APPROVAL_TRUNCATION_MARKER = "…[truncated]";
const EXEC_APPROVAL_OVERSIZED_MARKER = "[exec approval command exceeds display size limit; full text suppressed]";
const EXEC_APPROVAL_WARNING_OVERSIZED_MARKER = "[exec approval warning exceeds display size limit; full text suppressed]";
const BYPASS_MASK = "***";
function formatCodePointEscape(char) {
	return `\\u{${char.codePointAt(0)?.toString(16).toUpperCase() ?? "FFFD"}}`;
}
function normalizeDisplayLineBreaks(text) {
	return text.replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n");
}
function escapeInvisibles(text, options) {
	return text.replace(EXEC_APPROVAL_INVISIBLE_CHAR_REGEX, (char) => options?.preserveLineBreaks && char === "\n" ? "\n" : formatCodePointEscape(char));
}
function truncateForDisplay(text) {
	if (text.length <= EXEC_APPROVAL_MAX_OUTPUT) return text;
	return text.slice(0, EXEC_APPROVAL_MAX_OUTPUT) + EXEC_APPROVAL_TRUNCATION_MARKER;
}
function computeRedactionBitmap(text, patterns) {
	const bitmap = Array.from({ length: text.length }, () => false);
	for (const pattern of patterns) {
		const iter = pattern.flags.includes("g") ? new RegExp(pattern.source, pattern.flags) : new RegExp(pattern.source, `${pattern.flags}g`);
		for (const match of text.matchAll(iter)) {
			if (match.index === void 0) continue;
			const end = match.index + match[0].length;
			for (let i = match.index; i < end; i++) bitmap[i] = true;
		}
	}
	return bitmap;
}
function buildStrippedView(original) {
	const strippedChars = [];
	const strippedToOrig = [];
	let offset = 0;
	for (const cp of original) {
		if (!EXEC_APPROVAL_INVISIBLE_CHAR_SINGLE.test(cp)) {
			strippedChars.push(cp);
			for (let k = 0; k < cp.length; k++) strippedToOrig.push(offset + k);
		}
		offset += cp.length;
	}
	return {
		stripped: strippedChars.join(""),
		strippedToOrig
	};
}
function sanitizeExecApprovalDisplayTextInternal(commandText, options) {
	if (commandText.length > EXEC_APPROVAL_MAX_INPUT) return options?.oversizedMarker ?? EXEC_APPROVAL_OVERSIZED_MARKER;
	const rawRedacted = redactSensitiveText(commandText, { mode: "tools" });
	const { stripped, strippedToOrig } = buildStrippedView(commandText);
	if (redactSensitiveText(stripped, { mode: "tools" }) === stripped) return truncateForDisplay(escapeInvisibles(rawRedacted, options));
	const { patterns } = resolveRedactOptions({ mode: "tools" });
	const rawMask = computeRedactionBitmap(commandText, patterns);
	const strippedMask = computeRedactionBitmap(stripped, patterns);
	let bypassDetected = false;
	for (let i = 0; i < strippedMask.length; i++) if (strippedMask[i] && !rawMask[strippedToOrig[i]]) {
		bypassDetected = true;
		break;
	}
	if (!bypassDetected) return truncateForDisplay(escapeInvisibles(rawRedacted, options));
	const unionMask = rawMask.slice();
	for (let i = 0; i < strippedMask.length; i++) if (strippedMask[i]) unionMask[strippedToOrig[i]] = true;
	let out = "";
	let i = 0;
	while (i < commandText.length) {
		if (unionMask[i]) {
			let j = i;
			while (j < commandText.length && unionMask[j]) j++;
			out += BYPASS_MASK;
			i = j;
			continue;
		}
		const codePoint = commandText.codePointAt(i) ?? 65533;
		const cp = String.fromCodePoint(codePoint);
		out += options?.preserveLineBreaks && cp === "\n" ? cp : EXEC_APPROVAL_INVISIBLE_CHAR_SINGLE.test(cp) ? formatCodePointEscape(cp) : cp;
		i += cp.length;
	}
	return truncateForDisplay(out);
}
function sanitizeExecApprovalDisplayText(commandText) {
	return sanitizeExecApprovalDisplayTextInternal(commandText);
}
function sanitizeExecApprovalWarningText(warningText) {
	return sanitizeExecApprovalDisplayTextInternal(normalizeDisplayLineBreaks(warningText), {
		preserveLineBreaks: true,
		oversizedMarker: EXEC_APPROVAL_WARNING_OVERSIZED_MARKER
	});
}
function normalizePreview(commandText, commandPreview) {
	const previewRaw = commandPreview?.trim() ?? "";
	if (!previewRaw) return null;
	const preview = sanitizeExecApprovalDisplayText(previewRaw);
	if (preview === commandText) return null;
	return preview;
}
function resolveExecApprovalCommandDisplay(request) {
	const commandText = sanitizeExecApprovalDisplayText(request.command || (request.host === "node" && request.systemRunPlan ? request.systemRunPlan.commandText : ""));
	return {
		commandText,
		commandPreview: normalizePreview(commandText, request.commandPreview ?? (request.host === "node" ? request.systemRunPlan?.commandPreview ?? null : null))
	};
}
//#endregion
export { sanitizeExecApprovalDisplayText as n, sanitizeExecApprovalWarningText as r, resolveExecApprovalCommandDisplay as t };
