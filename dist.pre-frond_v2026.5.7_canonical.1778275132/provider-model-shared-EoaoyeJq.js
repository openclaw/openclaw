import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { t as createLazyImportLoader } from "./lazy-promise-AiZRy56y.js";
import "./gpt5-prompt-overlay-G1zZdl0L.js";
import "./provider-attribution-DzSzEwzu.js";
import { a as normalizeModelCompat } from "./provider-model-compat-DUJvsUk1.js";
import { n as sanitizeGoogleAssistantFirstOrdering, t as isGemma4ModelId } from "./google-models-BOd3D-0M.js";
//#region src/plugins/provider-replay-helpers.ts
function buildOpenAICompatibleReplayPolicy(modelApi, options = {}) {
	if (modelApi !== "openai-completions" && modelApi !== "openai-responses" && modelApi !== "openai-codex-responses" && modelApi !== "azure-openai-responses") return;
	return {
		...options.sanitizeToolCallIds ?? true ? {
			sanitizeToolCallIds: true,
			toolCallIdMode: "strict"
		} : {},
		...modelApi === "openai-completions" ? {
			applyAssistantFirstOrderingFix: true,
			validateGeminiTurns: true,
			validateAnthropicTurns: true
		} : {
			applyAssistantFirstOrderingFix: false,
			validateGeminiTurns: false,
			validateAnthropicTurns: false
		},
		...modelApi === "openai-completions" && isGemma4ModelId(options.modelId) ? { dropReasoningFromHistory: true } : {}
	};
}
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
*/
function shouldPreserveThinkingBlocks(modelId) {
	const id = normalizeLowercaseStringOrEmpty(modelId);
	if (!id.includes("claude")) return false;
	if (id.includes("opus-4") || id.includes("sonnet-4") || id.includes("haiku-4")) return true;
	if (/claude-[5-9]/.test(id) || /claude-\d{2,}/.test(id)) return true;
	return false;
}
function buildAnthropicReplayPolicyForModel(modelId) {
	return buildStrictAnthropicReplayPolicy({ dropThinkingBlocks: normalizeLowercaseStringOrEmpty(modelId).includes("claude") && !shouldPreserveThinkingBlocks(modelId) });
}
function buildNativeAnthropicReplayPolicyForModel(modelId) {
	return buildStrictAnthropicReplayPolicy({
		dropThinkingBlocks: normalizeLowercaseStringOrEmpty(modelId).includes("claude") && !shouldPreserveThinkingBlocks(modelId),
		sanitizeToolCallIds: true,
		preserveNativeAnthropicToolUseIds: true
	});
}
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
function sanitizeGoogleGeminiReplayHistory(ctx) {
	const messages = sanitizeGoogleAssistantFirstOrdering(ctx.messages);
	if (messages !== ctx.messages && ctx.sessionState && !hasGoogleTurnOrderingMarker(ctx.sessionState)) markGoogleTurnOrderingMarker(ctx.sessionState);
	return messages;
}
function resolveTaggedReasoningOutputMode() {
	return "tagged";
}
//#endregion
//#region src/plugin-sdk/provider-model-id-normalize.ts
const ANTIGRAVITY_BARE_PRO_IDS = new Set([
	"gemini-3-pro",
	"gemini-3.1-pro",
	"gemini-3-1-pro"
]);
function normalizeGooglePreviewModelId(id) {
	if (id === "gemini-3-pro") return "gemini-3-pro-preview";
	if (id === "gemini-3-flash") return "gemini-3-flash-preview";
	if (id === "gemini-3.1-pro") return "gemini-3.1-pro-preview";
	if (id === "gemini-3.1-flash-lite") return "gemini-3.1-flash-lite-preview";
	if (id === "gemini-3.1-flash" || id === "gemini-3.1-flash-preview") return "gemini-3-flash-preview";
	return id;
}
function normalizeAntigravityPreviewModelId(id) {
	if (ANTIGRAVITY_BARE_PRO_IDS.has(id)) return `${id}-low`;
	return id;
}
function normalizeNativeXaiModelId(id) {
	if (id === "grok-4-fast-reasoning") return "grok-4-fast";
	if (id === "grok-4-1-fast-reasoning") return "grok-4-1-fast";
	if (id === "grok-4.20-experimental-beta-0304-reasoning") return "grok-4.20-beta-latest-reasoning";
	if (id === "grok-4.20-experimental-beta-0304-non-reasoning") return "grok-4.20-beta-latest-non-reasoning";
	if (id === "grok-4.20-reasoning") return "grok-4.20-beta-latest-reasoning";
	if (id === "grok-4.20-non-reasoning") return "grok-4.20-beta-latest-non-reasoning";
	return id;
}
//#endregion
//#region src/agents/pi-embedded-runner/stream-payload-utils.ts
function streamWithPayloadPatch(underlying, model, context, options, patchPayload) {
	const originalOnPayload = options?.onPayload;
	return underlying(model, context, {
		...options,
		onPayload: (payload) => {
			if (payload && typeof payload === "object") patchPayload(payload);
			return originalOnPayload?.(payload, model);
		}
	});
}
//#endregion
//#region src/agents/pi-embedded-runner/moonshot-thinking-stream-wrappers.ts
const MOONSHOT_THINKING_KEEP_MODEL_ID = "kimi-k2.6";
const piAiRuntimeLoader = createLazyImportLoader(() => import("@mariozechner/pi-ai"));
async function loadDefaultStreamFn() {
	return (await piAiRuntimeLoader.load()).streamSimple;
}
function normalizeMoonshotThinkingType(value) {
	if (typeof value === "boolean") return value ? "enabled" : "disabled";
	if (typeof value === "string") {
		const normalized = normalizeOptionalLowercaseString(value);
		if (!normalized) return;
		if ([
			"enabled",
			"enable",
			"on",
			"true"
		].includes(normalized)) return "enabled";
		if ([
			"disabled",
			"disable",
			"off",
			"false"
		].includes(normalized)) return "disabled";
		return;
	}
	if (value && typeof value === "object" && !Array.isArray(value)) return normalizeMoonshotThinkingType(value.type);
}
function normalizeMoonshotThinkingKeep(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const keepValue = value.keep;
	if (typeof keepValue !== "string") return;
	return normalizeOptionalLowercaseString(keepValue) === "all" ? "all" : void 0;
}
function isMoonshotToolChoiceCompatible(toolChoice) {
	if (toolChoice == null || toolChoice === "auto" || toolChoice === "none") return true;
	if (typeof toolChoice === "object" && !Array.isArray(toolChoice)) {
		const typeValue = toolChoice.type;
		return typeValue === "auto" || typeValue === "none";
	}
	return false;
}
function isPinnedToolChoice(toolChoice) {
	if (!toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)) return false;
	const typeValue = toolChoice.type;
	return typeValue === "tool" || typeValue === "function";
}
function resolveMoonshotThinkingType(params) {
	const configured = normalizeMoonshotThinkingType(params.configuredThinking);
	if (configured) return configured;
	if (!params.thinkingLevel) return;
	return params.thinkingLevel === "off" ? "disabled" : "enabled";
}
function resolveMoonshotThinkingKeep(params) {
	return normalizeMoonshotThinkingKeep(params.configuredThinking);
}
function createMoonshotThinkingWrapper(baseStreamFn, thinkingType, thinkingKeep) {
	return async (model, context, options) => {
		return streamWithPayloadPatch(baseStreamFn ?? await loadDefaultStreamFn(), model, context, options, (payloadObj) => {
			let effectiveThinkingType = normalizeMoonshotThinkingType(payloadObj.thinking);
			if (thinkingType) {
				payloadObj.thinking = { type: thinkingType };
				effectiveThinkingType = thinkingType;
			}
			if (effectiveThinkingType === "enabled" && !isMoonshotToolChoiceCompatible(payloadObj.tool_choice)) {
				if (payloadObj.tool_choice === "required") payloadObj.tool_choice = "auto";
				else if (isPinnedToolChoice(payloadObj.tool_choice)) {
					payloadObj.thinking = { type: "disabled" };
					effectiveThinkingType = "disabled";
				}
			}
			const isKeepCapableModel = payloadObj.model === MOONSHOT_THINKING_KEEP_MODEL_ID;
			if (payloadObj.thinking && typeof payloadObj.thinking === "object") {
				const thinkingObj = payloadObj.thinking;
				if (isKeepCapableModel && effectiveThinkingType === "enabled" && thinkingKeep === "all") thinkingObj.keep = "all";
				else if ("keep" in thinkingObj) delete thinkingObj.keep;
			}
		});
	};
}
//#endregion
//#region src/plugins/provider-model-helpers.ts
function matchesExactOrPrefix(id, values) {
	const normalizedId = normalizeLowercaseStringOrEmpty(id);
	return values.some((value) => {
		const normalizedValue = normalizeLowercaseStringOrEmpty(value);
		return normalizedId === normalizedValue || normalizedId.startsWith(normalizedValue);
	});
}
function cloneFirstTemplateModel(params) {
	const trimmedModelId = params.modelId.trim();
	for (const templateId of [...new Set(params.templateIds)].filter(Boolean)) {
		const template = params.ctx.modelRegistry.find(params.providerId, templateId);
		if (!template) continue;
		return normalizeModelCompat({
			...template,
			id: trimmedModelId,
			name: trimmedModelId,
			...params.patch
		});
	}
}
//#endregion
//#region src/plugin-sdk/provider-model-shared.ts
const CLAUDE_OPUS_47_MODEL_PREFIXES = ["claude-opus-4-7", "claude-opus-4.7"];
const CLAUDE_ADAPTIVE_THINKING_DEFAULT_MODEL_PREFIXES = [
	"claude-opus-4-6",
	"claude-opus-4.6",
	"claude-sonnet-4-6",
	"claude-sonnet-4.6"
];
const BASE_CLAUDE_THINKING_LEVELS = [
	{ id: "off" },
	{ id: "minimal" },
	{ id: "low" },
	{ id: "medium" },
	{ id: "high" }
];
function getModelProviderHint(modelId) {
	const trimmed = normalizeOptionalLowercaseString(modelId);
	if (!trimmed) return null;
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0) return null;
	return trimmed.slice(0, slashIndex) || null;
}
function isProxyReasoningUnsupportedModelHint(modelId) {
	return getModelProviderHint(modelId) === "x-ai";
}
function matchesClaudeModelPrefix(modelId, prefixes) {
	const lower = normalizeOptionalLowercaseString(modelId);
	return Boolean(lower && prefixes.some((prefix) => lower.startsWith(prefix)));
}
function isClaudeOpus47ModelId(modelId) {
	return matchesClaudeModelPrefix(modelId, CLAUDE_OPUS_47_MODEL_PREFIXES);
}
function isClaudeAdaptiveThinkingDefaultModelId(modelId) {
	return matchesClaudeModelPrefix(modelId, CLAUDE_ADAPTIVE_THINKING_DEFAULT_MODEL_PREFIXES);
}
function resolveClaudeThinkingProfile(modelId) {
	if (isClaudeOpus47ModelId(modelId)) return {
		levels: [
			...BASE_CLAUDE_THINKING_LEVELS,
			{ id: "xhigh" },
			{ id: "adaptive" },
			{ id: "max" }
		],
		defaultLevel: "off"
	};
	if (isClaudeAdaptiveThinkingDefaultModelId(modelId)) return {
		levels: [...BASE_CLAUDE_THINKING_LEVELS, { id: "adaptive" }],
		defaultLevel: "adaptive"
	};
	return { levels: BASE_CLAUDE_THINKING_LEVELS };
}
function buildProviderReplayFamilyHooks(options) {
	switch (options.family) {
		case "openai-compatible": {
			const policyOptions = { sanitizeToolCallIds: options.sanitizeToolCallIds };
			return { buildReplayPolicy: (ctx) => buildOpenAICompatibleReplayPolicy(ctx.modelApi, {
				...policyOptions,
				modelId: ctx.modelId
			}) };
		}
		case "anthropic-by-model": return { buildReplayPolicy: ({ modelId }) => buildAnthropicReplayPolicyForModel(modelId) };
		case "native-anthropic-by-model": return { buildReplayPolicy: ({ modelId }) => buildNativeAnthropicReplayPolicyForModel(modelId) };
		case "google-gemini": return {
			buildReplayPolicy: () => buildGoogleGeminiReplayPolicy(),
			sanitizeReplayHistory: (ctx) => sanitizeGoogleGeminiReplayHistory(ctx),
			resolveReasoningOutputMode: (_ctx) => resolveTaggedReasoningOutputMode()
		};
		case "passthrough-gemini": return { buildReplayPolicy: ({ modelId }) => buildPassthroughGeminiSanitizingReplayPolicy(modelId) };
		case "hybrid-anthropic-openai": return { buildReplayPolicy: (ctx) => buildHybridAnthropicOrOpenAIReplayPolicy(ctx, { anthropicModelDropThinkingBlocks: options.anthropicModelDropThinkingBlocks }) };
	}
	throw new Error("Unsupported provider replay family");
}
const OPENAI_COMPATIBLE_REPLAY_HOOKS = buildProviderReplayFamilyHooks({ family: "openai-compatible" });
const ANTHROPIC_BY_MODEL_REPLAY_HOOKS = buildProviderReplayFamilyHooks({ family: "anthropic-by-model" });
const NATIVE_ANTHROPIC_REPLAY_HOOKS = buildProviderReplayFamilyHooks({ family: "native-anthropic-by-model" });
const PASSTHROUGH_GEMINI_REPLAY_HOOKS = buildProviderReplayFamilyHooks({ family: "passthrough-gemini" });
//#endregion
export { buildNativeAnthropicReplayPolicyForModel as C, resolveTaggedReasoningOutputMode as D, buildStrictAnthropicReplayPolicy as E, sanitizeGoogleGeminiReplayHistory as O, buildHybridAnthropicOrOpenAIReplayPolicy as S, buildPassthroughGeminiSanitizingReplayPolicy as T, normalizeAntigravityPreviewModelId as _, buildProviderReplayFamilyHooks as a, buildAnthropicReplayPolicyForModel as b, isClaudeOpus47ModelId as c, cloneFirstTemplateModel as d, matchesExactOrPrefix as f, streamWithPayloadPatch as g, resolveMoonshotThinkingType as h, PASSTHROUGH_GEMINI_REPLAY_HOOKS as i, shouldPreserveThinkingBlocks as k, isProxyReasoningUnsupportedModelHint as l, resolveMoonshotThinkingKeep as m, NATIVE_ANTHROPIC_REPLAY_HOOKS as n, getModelProviderHint as o, createMoonshotThinkingWrapper as p, OPENAI_COMPATIBLE_REPLAY_HOOKS as r, isClaudeAdaptiveThinkingDefaultModelId as s, ANTHROPIC_BY_MODEL_REPLAY_HOOKS as t, resolveClaudeThinkingProfile as u, normalizeGooglePreviewModelId as v, buildOpenAICompatibleReplayPolicy as w, buildGoogleGeminiReplayPolicy as x, normalizeNativeXaiModelId as y };
