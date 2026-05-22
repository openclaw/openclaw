import { r as resolveProviderRequestCapabilities } from "./provider-attribution-B2QMzk1g.js";
//#region src/agents/openai-completions-compat.ts
function isDefaultRouteProvider(provider, ...ids) {
	return provider !== void 0 && ids.includes(provider);
}
function resolveOpenAICompletionsCompatDefaults(input) {
	const { provider, endpointClass, knownProviderFamily, supportsNativeStreamingUsageCompat = false, supportsOpenAICompletionsStreamingUsageCompat = false, usesExplicitProxyLikeEndpoint = false } = input;
	const isDefaultRoute = endpointClass === "default";
	const usesConfiguredNonOpenAIEndpoint = endpointClass !== "default" && endpointClass !== "openai-public";
	const isMoonshotLike = knownProviderFamily === "moonshot" || knownProviderFamily === "modelstudio" || endpointClass === "moonshot-native" || endpointClass === "modelstudio-native";
	const isZai = endpointClass === "zai-native" || isDefaultRoute && isDefaultRouteProvider(input.provider, "zai");
	const isDeepSeek = endpointClass === "deepseek-native" || isDefaultRoute && isDefaultRouteProvider(input.provider, "deepseek");
	const isTogether = knownProviderFamily === "together" || isDefaultRoute && isDefaultRouteProvider(input.provider, "together");
	const isXiaomi = endpointClass === "xiaomi-native" || isDefaultRoute && isDefaultRouteProvider(input.provider, "xiaomi");
	const isNonStandard = endpointClass === "cerebras-native" || endpointClass === "chutes-native" || endpointClass === "deepseek-native" || endpointClass === "mistral-public" || endpointClass === "opencode-native" || endpointClass === "xai-native" || isXiaomi || isZai || isDefaultRoute && isDefaultRouteProvider(input.provider, "cerebras", "chutes", "deepseek", "opencode", "xai");
	const isOpenRouterLike = input.provider === "openrouter" || endpointClass === "openrouter";
	const isLocalEndpoint = endpointClass === "local";
	const usesMaxTokens = endpointClass === "chutes-native" || endpointClass === "mistral-public" || knownProviderFamily === "mistral" || isTogether || isDefaultRoute && isDefaultRouteProvider(provider, "chutes");
	return {
		supportsStore: !isNonStandard && knownProviderFamily !== "mistral" && !usesExplicitProxyLikeEndpoint,
		supportsDeveloperRole: !isNonStandard && !isMoonshotLike && !usesConfiguredNonOpenAIEndpoint,
		supportsReasoningEffort: !isZai && !isTogether && knownProviderFamily !== "mistral" && endpointClass !== "xai-native" && !usesExplicitProxyLikeEndpoint,
		supportsUsageInStreaming: supportsOpenAICompletionsStreamingUsageCompat || !isNonStandard && (isLocalEndpoint || !usesConfiguredNonOpenAIEndpoint || supportsNativeStreamingUsageCompat),
		maxTokensField: usesMaxTokens ? "max_tokens" : "max_completion_tokens",
		thinkingFormat: isDeepSeek || isXiaomi ? "deepseek" : isZai ? "zai" : isTogether ? "together" : isOpenRouterLike ? "openrouter" : "openai",
		visibleReasoningDetailTypes: isOpenRouterLike ? ["response.output_text", "response.text"] : [],
		supportsStrictMode: !isZai && !usesConfiguredNonOpenAIEndpoint,
		requiresReasoningContentOnAssistantMessages: isDeepSeek || isXiaomi
	};
}
function resolveOpenAICompletionsCompatDefaultsFromCapabilities(input) {
	return resolveOpenAICompletionsCompatDefaults(input);
}
function detectOpenAICompletionsCompat(model) {
	const capabilities = resolveProviderRequestCapabilities({
		provider: model.provider,
		api: "openai-completions",
		baseUrl: model.baseUrl,
		capability: "llm",
		transport: "stream",
		modelId: model.id,
		compat: model.compat && typeof model.compat === "object" ? model.compat : void 0
	});
	return {
		capabilities,
		defaults: resolveOpenAICompletionsCompatDefaultsFromCapabilities({
			provider: model.provider,
			...capabilities
		})
	};
}
//#endregion
//#region src/plugins/provider-model-compat.ts
function extractModelCompat(modelOrCompat) {
	if (!modelOrCompat || typeof modelOrCompat !== "object") return;
	if ("compat" in modelOrCompat) {
		const compat = modelOrCompat.compat;
		return compat && typeof compat === "object" ? compat : void 0;
	}
	return modelOrCompat;
}
/** @deprecated Provider-owned model compat helper; do not use from third-party plugins. */
function applyModelCompatPatch(model, patch) {
	const nextCompat = {
		...model.compat,
		...patch
	};
	const currentCompat = model.compat;
	if (model.compat && Object.entries(patch).every(([key, value]) => currentCompat?.[key] === value)) return model;
	return {
		...model,
		compat: nextCompat
	};
}
function hasToolSchemaProfile(modelOrCompat, profile) {
	return extractModelCompat(modelOrCompat)?.toolSchemaProfile === profile;
}
function hasNativeWebSearchTool(modelOrCompat) {
	return extractModelCompat(modelOrCompat)?.nativeWebSearchTool === true;
}
function resolveToolCallArgumentsEncoding(modelOrCompat) {
	return extractModelCompat(modelOrCompat)?.toolCallArgumentsEncoding;
}
function resolveUnsupportedToolSchemaKeywords(modelOrCompat) {
	const keywords = extractModelCompat(modelOrCompat)?.unsupportedToolSchemaKeywords ?? [];
	return new Set(keywords.filter((keyword) => typeof keyword === "string").map((keyword) => keyword.trim()).filter(Boolean));
}
function shouldOmitEmptyArrayItems(modelOrCompat) {
	return extractModelCompat(modelOrCompat)?.omitEmptyArrayItems === true;
}
function isOpenAiCompletionsModel(model) {
	return model.api === "openai-completions";
}
function isAnthropicMessagesModel(model) {
	return model.api === "anthropic-messages";
}
function normalizeAnthropicBaseUrl(baseUrl) {
	return baseUrl.replace(/\/v1\/?$/, "");
}
function normalizeModelCompat(model) {
	const baseUrl = model.baseUrl ?? "";
	if (isAnthropicMessagesModel(model) && baseUrl) {
		const normalized = normalizeAnthropicBaseUrl(baseUrl);
		if (normalized !== baseUrl) return {
			...model,
			baseUrl: normalized
		};
	}
	if (!isOpenAiCompletionsModel(model)) return model;
	const compat = model.compat ?? void 0;
	const detectedCompatDefaults = baseUrl ? detectOpenAICompletionsCompat(model).defaults : void 0;
	if (!Boolean(detectedCompatDefaults && (!detectedCompatDefaults.supportsDeveloperRole || !detectedCompatDefaults.supportsUsageInStreaming || !detectedCompatDefaults.supportsStrictMode))) return model;
	const forcedDeveloperRole = compat?.supportsDeveloperRole === true;
	const hasStreamingUsageOverride = compat?.supportsUsageInStreaming !== void 0;
	const targetStrictMode = compat?.supportsStrictMode ?? detectedCompatDefaults?.supportsStrictMode;
	if (compat?.supportsDeveloperRole !== void 0 && hasStreamingUsageOverride && compat?.supportsStrictMode !== void 0) return model;
	return {
		...model,
		compat: compat ? {
			...compat,
			supportsDeveloperRole: forcedDeveloperRole || false,
			...hasStreamingUsageOverride ? {} : { supportsUsageInStreaming: detectedCompatDefaults?.supportsUsageInStreaming ?? false },
			supportsStrictMode: targetStrictMode
		} : {
			supportsDeveloperRole: false,
			supportsUsageInStreaming: detectedCompatDefaults?.supportsUsageInStreaming ?? false,
			supportsStrictMode: detectedCompatDefaults?.supportsStrictMode ?? false
		}
	};
}
//#endregion
export { normalizeModelCompat as a, shouldOmitEmptyArrayItems as c, hasToolSchemaProfile as i, detectOpenAICompletionsCompat as l, extractModelCompat as n, resolveToolCallArgumentsEncoding as o, hasNativeWebSearchTool as r, resolveUnsupportedToolSchemaKeywords as s, applyModelCompatPatch as t };
