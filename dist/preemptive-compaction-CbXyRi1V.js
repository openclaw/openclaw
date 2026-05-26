import { i as estimateMessagesTokens, l as estimateToolResultReductionPotential, t as SAFETY_MARGIN } from "./compaction-xbracGie.js";
import { o as MIN_PROMPT_BUDGET_RATIO, s as MIN_PROMPT_BUDGET_TOKENS } from "./pi-settings-DM7yYbel.js";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
//#region src/agents/pi-embedded-runner/run/preemptive-compaction.ts
const PREEMPTIVE_OVERFLOW_ERROR_TEXT = "Context overflow: prompt too large for the model (precheck).";
const ESTIMATED_CHARS_PER_TOKEN = 4;
const TRUNCATION_ROUTE_BUFFER_TOKENS = 512;
function estimatePrePromptTokens(params) {
	const { messages, systemPrompt, prompt } = params;
	const syntheticMessages = [];
	if (typeof systemPrompt === "string" && systemPrompt.trim().length > 0) syntheticMessages.push({
		role: "system",
		content: systemPrompt,
		timestamp: 0
	});
	syntheticMessages.push({
		role: "user",
		content: prompt,
		timestamp: 0
	});
	const estimated = estimateMessagesTokens(messages) + syntheticMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
	return Math.max(0, Math.ceil(estimated * SAFETY_MARGIN));
}
function shouldPreemptivelyCompactBeforePrompt(params) {
	let messagesForPressure = params.messages;
	let estimatedPromptTokens = estimatePrePromptTokens({
		messages: params.messages,
		systemPrompt: params.systemPrompt,
		prompt: params.prompt
	});
	if (params.unwindowedMessages && params.unwindowedMessages !== params.messages) {
		const unwindowedEstimatedPromptTokens = estimatePrePromptTokens({
			messages: params.unwindowedMessages,
			systemPrompt: params.systemPrompt,
			prompt: params.prompt
		});
		if (unwindowedEstimatedPromptTokens > estimatedPromptTokens) {
			estimatedPromptTokens = unwindowedEstimatedPromptTokens;
			messagesForPressure = params.unwindowedMessages;
		}
	}
	const contextTokenBudget = Math.max(1, Math.floor(params.contextTokenBudget));
	const requestedReserveTokens = Math.max(0, Math.floor(params.reserveTokens));
	const minPromptBudget = Math.min(MIN_PROMPT_BUDGET_TOKENS, Math.max(1, Math.floor(contextTokenBudget * MIN_PROMPT_BUDGET_RATIO)));
	const effectiveReserveTokens = Math.min(requestedReserveTokens, Math.max(0, contextTokenBudget - minPromptBudget));
	const promptBudgetBeforeReserve = Math.max(1, contextTokenBudget - effectiveReserveTokens);
	const overflowTokens = Math.max(0, estimatedPromptTokens - promptBudgetBeforeReserve);
	const toolResultPotential = estimateToolResultReductionPotential({
		messages: messagesForPressure,
		contextWindowTokens: params.contextTokenBudget,
		maxCharsOverride: params.toolResultMaxChars
	});
	const overflowChars = overflowTokens * ESTIMATED_CHARS_PER_TOKEN;
	const truncationBufferChars = TRUNCATION_ROUTE_BUFFER_TOKENS * ESTIMATED_CHARS_PER_TOKEN;
	const truncateOnlyThresholdChars = Math.max(overflowChars + truncationBufferChars, Math.ceil(overflowChars * 1.5));
	const toolResultReducibleChars = toolResultPotential.maxReducibleChars;
	let route = "fits";
	if (overflowTokens > 0) if (toolResultReducibleChars <= 0) route = "compact_only";
	else if (toolResultReducibleChars >= truncateOnlyThresholdChars) route = "truncate_tool_results_only";
	else route = "compact_then_truncate";
	return {
		route,
		shouldCompact: route === "compact_only" || route === "compact_then_truncate",
		estimatedPromptTokens,
		promptBudgetBeforeReserve,
		overflowTokens,
		toolResultReducibleChars,
		effectiveReserveTokens
	};
}
//#endregion
export { shouldPreemptivelyCompactBeforePrompt as n, PREEMPTIVE_OVERFLOW_ERROR_TEXT as t };
