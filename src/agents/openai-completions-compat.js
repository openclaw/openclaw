import { resolveProviderRequestCapabilities } from "./provider-attribution.js";
function isDefaultRouteProvider(provider, ...ids) {
    return provider !== undefined && ids.includes(provider);
}
const KNOWN_LOCAL_STREAMING_USAGE_PROVIDERS = new Set([
    "jan",
    "llama-cpp",
    "llama.cpp",
    "llamacpp",
    "lm-studio",
    "lmstudio",
    "localai",
    "sglang",
    "tabby",
    "tabbyapi",
    "text-generation-webui",
    "vllm",
]);
function isKnownLocalStreamingUsageProvider(...ids) {
    return ids.some((id) => id !== undefined && KNOWN_LOCAL_STREAMING_USAGE_PROVIDERS.has(id.toLowerCase()));
}
export function resolveOpenAICompletionsCompatDefaults(input) {
    const { provider, endpointClass, knownProviderFamily, supportsNativeStreamingUsageCompat = false, usesExplicitProxyLikeEndpoint = false, } = input;
    const isDefaultRoute = endpointClass === "default";
    const usesConfiguredNonOpenAIEndpoint = endpointClass !== "default" && endpointClass !== "openai-public";
    const isMoonshotLike = knownProviderFamily === "moonshot" ||
        knownProviderFamily === "modelstudio" ||
        endpointClass === "moonshot-native" ||
        endpointClass === "modelstudio-native";
    const isZai = endpointClass === "zai-native" ||
        (isDefaultRoute && isDefaultRouteProvider(input.provider, "zai"));
    const isDeepSeek = endpointClass === "deepseek-native" ||
        (isDefaultRoute && isDefaultRouteProvider(input.provider, "deepseek"));
    const isNonStandard = endpointClass === "cerebras-native" ||
        endpointClass === "chutes-native" ||
        endpointClass === "deepseek-native" ||
        endpointClass === "mistral-public" ||
        endpointClass === "opencode-native" ||
        endpointClass === "xai-native" ||
        isZai ||
        (isDefaultRoute &&
            isDefaultRouteProvider(input.provider, "cerebras", "chutes", "deepseek", "opencode", "xai"));
    const isOpenRouterLike = input.provider === "openrouter" || endpointClass === "openrouter";
    const usesMaxTokens = endpointClass === "chutes-native" ||
        endpointClass === "mistral-public" ||
        knownProviderFamily === "mistral" ||
        (isDefaultRoute && isDefaultRouteProvider(provider, "chutes"));
    const supportsKnownLocalStreamingUsage = isKnownLocalStreamingUsageProvider(provider, knownProviderFamily);
    return {
        supportsStore: !isNonStandard && knownProviderFamily !== "mistral" && !usesExplicitProxyLikeEndpoint,
        supportsDeveloperRole: !isNonStandard && !isMoonshotLike && !usesConfiguredNonOpenAIEndpoint,
        supportsReasoningEffort: !isZai &&
            knownProviderFamily !== "mistral" &&
            endpointClass !== "xai-native" &&
            !usesExplicitProxyLikeEndpoint,
        supportsUsageInStreaming: supportsKnownLocalStreamingUsage ||
            (!isNonStandard && (!usesConfiguredNonOpenAIEndpoint || supportsNativeStreamingUsageCompat)),
        maxTokensField: usesMaxTokens ? "max_tokens" : "max_completion_tokens",
        thinkingFormat: isDeepSeek
            ? "deepseek"
            : isZai
                ? "zai"
                : isOpenRouterLike
                    ? "openrouter"
                    : "openai",
        visibleReasoningDetailTypes: isOpenRouterLike ? ["response.output_text", "response.text"] : [],
        supportsStrictMode: !isZai && !usesConfiguredNonOpenAIEndpoint,
    };
}
export function resolveOpenAICompletionsCompatDefaultsFromCapabilities(input) {
    return resolveOpenAICompletionsCompatDefaults(input);
}
export function detectOpenAICompletionsCompat(model) {
    const capabilities = resolveProviderRequestCapabilities({
        provider: model.provider,
        api: "openai-completions",
        baseUrl: model.baseUrl,
        capability: "llm",
        transport: "stream",
        modelId: model.id,
        compat: model.compat && typeof model.compat === "object"
            ? model.compat
            : undefined,
    });
    return {
        capabilities,
        defaults: resolveOpenAICompletionsCompatDefaultsFromCapabilities({
            provider: model.provider,
            ...capabilities,
        }),
    };
}
