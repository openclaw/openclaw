import { n as INTERNAL_RUNTIME_CONTEXT_END, s as escapeInternalRuntimeContextDelimiters, t as INTERNAL_RUNTIME_CONTEXT_BEGIN } from "./internal-runtime-context-DWxvZFcB.js";
import { p as formatGeneratedAttachmentLines } from "./subagent-announce-delivery-p160OmJs.js";
import { n as wrapPromptDataBlock } from "./sanitize-for-prompt-ByaJGDhT.js";
//#region src/agents/internal-events.ts
function sanitizeSingleLineField(value, fallback) {
	return escapeInternalRuntimeContextDelimiters(value).replace(/\r?\n+/g, " ").trim() || fallback;
}
function sanitizeMultilineField(value, fallback) {
	return escapeInternalRuntimeContextDelimiters(value).replace(/\r\n/g, "\n").trim() || fallback;
}
function formatChildResultDataBlock(value) {
	return wrapPromptDataBlock({
		label: "Child result",
		text: value
	}) || "Child result: (no output)";
}
function formatTaskCompletionEvent(event) {
	const sessionKey = sanitizeSingleLineField(event.childSessionKey, "unknown");
	const sessionId = sanitizeSingleLineField(event.childSessionId ?? "unknown", "unknown");
	const announceType = sanitizeSingleLineField(event.announceType, "unknown");
	const taskLabel = sanitizeSingleLineField(event.taskLabel, "unnamed task");
	const statusLabel = sanitizeSingleLineField(event.statusLabel, event.status);
	const result = formatChildResultDataBlock(event.result);
	const attachmentLines = formatGeneratedAttachmentLines(event.attachments);
	const lines = [
		"[Internal task completion event]",
		`source: ${event.source}`,
		`session_key: ${sessionKey}`,
		`session_id: ${sessionId}`,
		`type: ${announceType}`,
		`task: ${taskLabel}`,
		`status: ${statusLabel}`,
		"",
		result
	];
	if (attachmentLines.length > 0) lines.push("", ...attachmentLines);
	if (event.statsLine?.trim()) lines.push("", sanitizeMultilineField(event.statsLine, ""));
	lines.push("", "Action:", sanitizeMultilineField(event.replyInstruction, ""));
	return lines.join("\n");
}
function formatTaskCompletionEventForPlainPrompt(event) {
	const sessionKey = sanitizeSingleLineField(event.childSessionKey, "unknown");
	const sessionId = sanitizeSingleLineField(event.childSessionId ?? "unknown", "unknown");
	const announceType = sanitizeSingleLineField(event.announceType, "unknown");
	const taskLabel = sanitizeSingleLineField(event.taskLabel, "unnamed task");
	const statusLabel = sanitizeSingleLineField(event.statusLabel, event.status);
	const result = formatChildResultDataBlock(event.result);
	const attachmentLines = formatGeneratedAttachmentLines(event.attachments);
	const lines = [
		"A background task completed. Use this result to reply to the user in your normal assistant voice.",
		"",
		`source: ${event.source}`,
		`session_key: ${sessionKey}`,
		`session_id: ${sessionId}`,
		`type: ${announceType}`,
		`task: ${taskLabel}`,
		`status: ${statusLabel}`,
		"",
		result
	];
	if (attachmentLines.length > 0) lines.push("", ...attachmentLines);
	if (event.statsLine?.trim()) lines.push("", sanitizeMultilineField(event.statsLine, ""));
	lines.push("", "Instruction:", sanitizeMultilineField(event.replyInstruction, ""));
	return lines.join("\n");
}
function formatAgentInternalEventsForPrompt(events) {
	if (!events || events.length === 0) return "";
	const blocks = events.map((event) => {
		if (event.type === "task_completion") return formatTaskCompletionEvent(event);
		return "";
	}).filter((value) => value.trim().length > 0);
	if (blocks.length === 0) return "";
	return [
		INTERNAL_RUNTIME_CONTEXT_BEGIN,
		"OpenClaw runtime context (internal):",
		"This context is runtime-generated, not user-authored. Keep internal details private.",
		"",
		blocks.join("\n\n---\n\n"),
		INTERNAL_RUNTIME_CONTEXT_END
	].join("\n");
}
function formatAgentInternalEventsForPlainPrompt(events) {
	if (!events || events.length === 0) return "";
	return events.map((event) => {
		if (event.type === "task_completion") return formatTaskCompletionEventForPlainPrompt(event);
		return "";
	}).filter((value) => value.trim().length > 0).join("\n\n---\n\n");
}
//#endregion
export { formatAgentInternalEventsForPrompt as n, formatAgentInternalEventsForPlainPrompt as t };
