//#region src/agents/timeout.ts
const DEFAULT_AGENT_TIMEOUT_SECONDS = 2880 * 60;
const MAX_SAFE_TIMEOUT_MS = 2147e6;
const normalizeNumber = (value) => typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : void 0;
function resolveAgentTimeoutSeconds(cfg) {
	const seconds = normalizeNumber(cfg?.agents?.defaults?.timeoutSeconds) ?? DEFAULT_AGENT_TIMEOUT_SECONDS;
	return Math.max(seconds, 1);
}
function resolveAgentTimeoutMs(opts) {
	const minMs = Math.max(normalizeNumber(opts.minMs) ?? 1, 1);
	const clampTimeoutMs = (valueMs) => Math.min(Math.max(valueMs, minMs), MAX_SAFE_TIMEOUT_MS);
	const defaultMs = clampTimeoutMs(resolveAgentTimeoutSeconds(opts.cfg) * 1e3);
	const NO_TIMEOUT_MS = MAX_SAFE_TIMEOUT_MS;
	const overrideMs = normalizeNumber(opts.overrideMs);
	if (overrideMs !== void 0) {
		if (overrideMs === 0) return NO_TIMEOUT_MS;
		if (overrideMs < 0) return defaultMs;
		return clampTimeoutMs(overrideMs);
	}
	const overrideSeconds = normalizeNumber(opts.overrideSeconds);
	if (overrideSeconds !== void 0) {
		if (overrideSeconds === 0) return NO_TIMEOUT_MS;
		if (overrideSeconds < 0) return defaultMs;
		return clampTimeoutMs(overrideSeconds * 1e3);
	}
	return defaultMs;
}
//#endregion
//#region src/tasks/task-completion-contract.ts
const PROGRESS_ONLY_PATTERN = /^(?:i(?:'|\u2019)ll|i will|i(?:'|\u2019)m|i am|i(?:'|\u2019)m going to|i am going to|let me|i need to)\s+(?:now\s+)?(?:analyz(?:e|ing)|apply|check(?:ing)?|continue|debug(?:ging)?|follow(?:ing)?\s+up|inspect(?:ing)?|investigat(?:e|ing)|look(?:ing)?(?:\s+into)?|map(?:ping)?|open(?:ing)?|read(?:ing)?|report(?:ing)?(?:\s+back)?|review(?:ing)?|run(?:ning)?|start(?:ing)?|test(?:ing)?|trace|trac(?:e|ing)|try(?:ing)?|update|verify(?:ing)?|work(?:ing)?)/i;
const BARE_PROGRESS_ONLY_PATTERN = /^(?:analyz(?:e|ing)|check(?:ing)?|debug(?:ging)?|inspect(?:ing)?|investigat(?:e|ing)|look(?:ing)?\s+into|map(?:ping)?|read(?:ing)?|report(?:ing)?\s+back|review(?:ing)?|run(?:ning)?|test(?:ing)?|trac(?:e|ing)|verify(?:ing)?|work(?:ing)?\s+on)\b/i;
const FOLLOW_UP_PLANNING_PREFIX_PATTERN = /^(?:after(?:wards|\s+that)?|from\s+there|next|once\s+(?:done|that(?:'|\u2019)?s\s+done|that\s+is\s+done)|then)[,.\s]+/i;
function normalizeCompletionText(value) {
	return value?.replace(/\s+/g, " ").trim() ?? "";
}
function normalizeCompletionFailureReason(value) {
	const normalized = normalizeCompletionText(value);
	if (!normalized) return "";
	return normalized.length <= 160 ? normalized : `${normalized.slice(0, 159)}...`;
}
function matchesProgressOnlyPrefix(value) {
	if (PROGRESS_ONLY_PATTERN.test(value) || BARE_PROGRESS_ONLY_PATTERN.test(value)) return true;
	const followup = value.replace(FOLLOW_UP_PLANNING_PREFIX_PATTERN, "").trim();
	return followup !== value && (PROGRESS_ONLY_PATTERN.test(followup) || BARE_PROGRESS_ONLY_PATTERN.test(followup));
}
function hasNonProgressFollowupSentence(value) {
	const boundary = /(?:[.!?:]|\s[-\u2013\u2014])\s+\S/.exec(value);
	if (!boundary) return false;
	const separatorEnd = boundary.index + boundary[0].length - 1;
	const firstSentence = value.slice(0, separatorEnd).trim();
	const rest = value.slice(separatorEnd).trim();
	return matchesProgressOnlyPrefix(firstSentence) && !isProgressOnlyCompletionText(rest);
}
function isProgressOnlyCompletionText(value) {
	const normalized = normalizeCompletionText(value);
	if (!normalized) return false;
	if (hasNonProgressFollowupSentence(normalized)) return false;
	return matchesProgressOnlyPrefix(normalized);
}
function resolveRequiredCompletionTerminalResult(resultText) {
	const normalized = normalizeCompletionText(resultText);
	if (!normalized) return {
		terminalOutcome: "blocked",
		terminalSummary: "Required completion did not produce a final deliverable."
	};
	if (isProgressOnlyCompletionText(normalized)) return {
		terminalOutcome: "blocked",
		terminalSummary: "Required completion ended with progress-only text, not a final deliverable."
	};
	return {};
}
function resolveRequiredCompletionDeliveryFailureTerminalResult(reason) {
	const normalizedReason = normalizeCompletionFailureReason(reason);
	return {
		terminalOutcome: "blocked",
		terminalSummary: normalizedReason ? `Required completion delivery failed before reaching the requester: ${normalizedReason}.` : "Required completion delivery failed before reaching the requester."
	};
}
//#endregion
export { resolveRequiredCompletionTerminalResult as n, resolveAgentTimeoutMs as r, resolveRequiredCompletionDeliveryFailureTerminalResult as t };
