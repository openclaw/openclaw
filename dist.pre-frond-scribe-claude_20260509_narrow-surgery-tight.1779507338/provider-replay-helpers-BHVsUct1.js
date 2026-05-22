import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { n as sanitizeGoogleAssistantFirstOrdering, t as isGemma4ModelId } from "./google-models-C65oke3q.js";
//#region src/plugins/provider-replay-helpers.ts
/** @deprecated Provider replay helper; prefer provider-local replay hooks. */
function buildOpenAICompatibleReplayPolicy(modelApi, options = {}) {
	if (modelApi !== "openai-completions" && modelApi !== "openai-responses" && modelApi !== "openai-codex-responses" && modelApi !== "azure-openai-responses") return;
	const sanitizeToolCallIds = options.sanitizeToolCallIds ?? true;
	const dropReasoningFromHistory = options.dropReasoningFromHistory ?? true;
	const isResponsesFamily = modelApi === "openai-responses" || modelApi === "openai-codex-responses" || modelApi === "azure-openai-responses";
	return {
		...sanitizeToolCallIds ? {
			sanitizeToolCallIds: true,
			toolCallIdMode: "strict"
		} : {},
		...isResponsesFamily ? { allowSyntheticToolResults: true } : {},
		...modelApi === "openai-completions" ? {
			applyAssistantFirstOrderingFix: true,
			validateGeminiTurns: true,
			validateAnthropicTurns: true
		} : {
			applyAssistantFirstOrderingFix: false,
			validateGeminiTurns: false,
			validateAnthropicTurns: false
		},
		...modelApi === "openai-completions" && (dropReasoningFromHistory || isGemma4ModelId(options.modelId)) ? { dropReasoningFromHistory: true } : {}
	};
}
/** @deprecated Anthropic-family provider replay helper; prefer provider-local replay hooks. */
function buildStrictAnthropicReplayPolicy(options = {}) {
	return {
		sanitizeMode: "full",
		...options.sanitizeToolCallIds ?? true ? {
			sanitizeToolCallIds: true,
			toolCallIdMode: "strict",
			...options.preserveNativeAnthropicToolUseIds ? { preserveNativeAnthropicToolUseIds: true } : {}
		} : {},
		preserveSignatures: true,
		repairToolUseResultPairing: true,
		validateAnthropicTurns: true,
		allowSyntheticToolResults: true,
		...options.dropThinkingBlocks ? { dropThinkingBlocks: true } : {}
	};
}
/**
* Returns true for Claude models that preserve thinking blocks in context
* natively (Opus 4.5+, Sonnet 4.5+, Haiku 4.5+). For these models, dropping
* thinking blocks from prior turns breaks prompt cache prefix matching.
*
* See: https://platform.claude.com/docs/en/build-with-claude/extended-thinking#differences-in-thinking-across-model-versions
*
* @deprecated Anthropic-family provider replay helper; prefer provider-local replay hooks.
*/
function shouldPreserveThinkingBlocks(modelId) {
	const id = normalizeLowercaseStringOrEmpty(modelId);
	if (!id.includes("claude")) return false;
	if (id.includes("opus-4") || id.includes("sonnet-4") || id.includes("haiku-4")) return true;
	if (/claude-[5-9]/.test(id) || /claude-\d{2,}/.test(id)) return true;
	return false;
}
/** @deprecated Anthropic-family provider replay helper; prefer provider-local replay hooks. */
function buildAnthropicReplayPolicyForModel(modelId) {
	return buildStrictAnthropicReplayPolicy({ dropThinkingBlocks: normalizeLowercaseStringOrEmpty(modelId).includes("claude") && !shouldPreserveThinkingBlocks(modelId) });
}
/** @deprecated Anthropic-family provider replay helper; prefer provider-local replay hooks. */
function buildNativeAnthropicReplayPolicyForModel(modelId) {
	return buildStrictAnthropicReplayPolicy({
		dropThinkingBlocks: normalizeLowercaseStringOrEmpty(modelId).includes("claude") && !shouldPreserveThinkingBlocks(modelId),
		sanitizeToolCallIds: true,
		preserveNativeAnthropicToolUseIds: true
	});
}
/** @deprecated Provider replay helper; prefer provider-local replay hooks. */
function buildHybridAnthropicOrOpenAIReplayPolicy(ctx, options = {}) {
	if (ctx.modelApi === "anthropic-messages" || ctx.modelApi === "bedrock-converse-stream") {
		const isClaude = normalizeLowercaseStringOrEmpty(ctx.modelId).includes("claude");
		return buildStrictAnthropicReplayPolicy({ dropThinkingBlocks: options.anthropicModelDropThinkingBlocks && isClaude && !shouldPreserveThinkingBlocks(ctx.modelId) });
	}
	return buildOpenAICompatibleReplayPolicy(ctx.modelApi, { modelId: ctx.modelId });
}
const GOOGLE_TURN_ORDERING_CUSTOM_TYPE = "google-turn-ordering-bootstrap";
function hasGoogleTurnOrderingMarker(sessionState) {
	return sessionState.getCustomEntries().some((entry) => entry.customType === GOOGLE_TURN_ORDERING_CUSTOM_TYPE);
}
function markGoogleTurnOrderingMarker(sessionState) {
	sessionState.appendCustomEntry(GOOGLE_TURN_ORDERING_CUSTOM_TYPE, { timestamp: Date.now() });
}
/** @deprecated Google provider replay helper; prefer provider-local replay hooks. */
function buildGoogleGeminiReplayPolicy() {
	return {
		sanitizeMode: "full",
		sanitizeToolCallIds: true,
		toolCallIdMode: "strict",
		sanitizeThoughtSignatures: {
			allowBase64Only: true,
			includeCamelCase: true
		},
		repairToolUseResultPairing: true,
		applyAssistantFirstOrderingFix: true,
		validateGeminiTurns: true,
		validateAnthropicTurns: false,
		allowSyntheticToolResults: true
	};
}
/** @deprecated Google provider replay helper; prefer provider-local replay hooks. */
function buildPassthroughGeminiSanitizingReplayPolicy(modelId) {
	return {
		applyAssistantFirstOrderingFix: false,
		validateGeminiTurns: false,
		validateAnthropicTurns: false,
		...normalizeLowercaseStringOrEmpty(modelId).includes("gemini") ? { sanitizeThoughtSignatures: {
			allowBase64Only: true,
			includeCamelCase: true
		} } : {}
	};
}
/** @deprecated Google provider replay helper; prefer provider-local replay hooks. */
function sanitizeGoogleGeminiReplayHistory(ctx) {
	const messages = sanitizeGoogleAssistantFirstOrdering(ctx.messages);
	if (messages !== ctx.messages && ctx.sessionState && !hasGoogleTurnOrderingMarker(ctx.sessionState)) markGoogleTurnOrderingMarker(ctx.sessionState);
	return messages;
}
/** @deprecated Provider replay helper; prefer provider-local replay hooks. */
function resolveTaggedReasoningOutputMode() {
	return "tagged";
}
//#endregion
export { buildOpenAICompatibleReplayPolicy as a, resolveTaggedReasoningOutputMode as c, buildNativeAnthropicReplayPolicyForModel as i, sanitizeGoogleGeminiReplayHistory as l, buildGoogleGeminiReplayPolicy as n, buildPassthroughGeminiSanitizingReplayPolicy as o, buildHybridAnthropicOrOpenAIReplayPolicy as r, buildStrictAnthropicReplayPolicy as s, buildAnthropicReplayPolicyForModel as t, shouldPreserveThinkingBlocks as u };
