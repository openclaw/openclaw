import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { r as isInternalMessageChannel } from "./message-channel-CYCKkVrh.js";
import { r as prefixSystemMessage, t as SYSTEM_MARK } from "./system-message-DcYqWFJX.js";
//#region src/auto-reply/reply/directive-handling.shared.ts
const formatDirectiveAck = (text) => {
	return prefixSystemMessage(text);
};
const formatOptionsLine = (options) => `Options: ${options}.`;
const withOptions = (line, options) => `${line}\n${formatOptionsLine(options)}`;
const formatElevatedRuntimeHint = () => `${SYSTEM_MARK} Runtime is direct; sandboxing does not apply.`;
const formatInternalExecPersistenceDeniedText = () => "Exec defaults require operator.admin for internal gateway callers; skipped persistence.";
const formatInternalVerbosePersistenceDeniedText = () => "Verbose defaults require operator.admin for internal gateway callers; skipped persistence.";
const formatInternalVerboseCurrentReplyOnlyText = () => "Verbose logging set for the current reply only.";
function canPersistInternalDirective(params) {
	if (!isInternalMessageChannel(isInternalMessageChannel(params.messageProvider) ? params.messageProvider : params.surface)) return true;
	return (params.gatewayClientScopes ?? []).includes("operator.admin");
}
const canPersistInternalExecDirective = canPersistInternalDirective;
const canPersistInternalVerboseDirective = canPersistInternalDirective;
const formatElevatedEvent = (level) => {
	if (level === "full") return "Elevated FULL - exec runs on host with auto-approval.";
	if (level === "ask" || level === "on") return "Elevated ASK - exec runs on host; approvals may still apply.";
	return "Elevated OFF - exec stays in sandbox.";
};
const formatReasoningEvent = (level) => {
	if (level === "stream") return "Reasoning STREAM - emit live <think>.";
	if (level === "on") return "Reasoning ON - include <think>.";
	return "Reasoning OFF - hide <think>.";
};
function enqueueModeSwitchEvents(params) {
	if (params.elevatedChanged) {
		const nextElevated = params.sessionEntry.elevatedLevel ?? "off";
		params.enqueueSystemEvent(formatElevatedEvent(nextElevated), {
			sessionKey: params.sessionKey,
			contextKey: "mode:elevated"
		});
	}
	if (params.reasoningChanged) {
		const nextReasoning = params.sessionEntry.reasoningLevel ?? "off";
		params.enqueueSystemEvent(formatReasoningEvent(nextReasoning), {
			sessionKey: params.sessionKey,
			contextKey: "mode:reasoning"
		});
	}
}
function formatElevatedUnavailableText(params) {
	const lines = [];
	lines.push(`elevated is not available right now (runtime=${params.runtimeSandboxed ? "sandboxed" : "direct"}).`);
	const failures = params.failures ?? [];
	if (failures.length > 0) lines.push(`Failing gates: ${failures.map((f) => `${f.gate} (${f.key})`).join(", ")}`);
	else lines.push("Fix-it keys: tools.elevated.enabled, tools.elevated.allowFrom.<provider>, agents.list[].tools.elevated.*");
	if (params.sessionKey) lines.push(`See: ${formatCliCommand(`openclaw sandbox explain --session ${params.sessionKey}`)}`);
	return lines.join("\n");
}
//#endregion
export { formatElevatedRuntimeHint as a, formatInternalVerboseCurrentReplyOnlyText as c, formatDirectiveAck as i, formatInternalVerbosePersistenceDeniedText as l, canPersistInternalVerboseDirective as n, formatElevatedUnavailableText as o, enqueueModeSwitchEvents as r, formatInternalExecPersistenceDeniedText as s, canPersistInternalExecDirective as t, withOptions as u };
