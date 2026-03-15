//#region src/infra/exec-approval-command-display.ts
const UNICODE_FORMAT_CHAR_REGEX = /\p{Cf}/gu;
function formatCodePointEscape(char) {
	return `\\u{${char.codePointAt(0)?.toString(16).toUpperCase() ?? "FFFD"}}`;
}
function sanitizeExecApprovalDisplayText(commandText) {
	return commandText.replace(UNICODE_FORMAT_CHAR_REGEX, formatCodePointEscape);
}
function normalizePreview(commandText, commandPreview) {
	const previewRaw = commandPreview?.trim() ?? "";
	if (!previewRaw) {return null;}
	const preview = sanitizeExecApprovalDisplayText(previewRaw);
	if (preview === commandText) {return null;}
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
export { sanitizeExecApprovalDisplayText as n, resolveExecApprovalCommandDisplay as t };
