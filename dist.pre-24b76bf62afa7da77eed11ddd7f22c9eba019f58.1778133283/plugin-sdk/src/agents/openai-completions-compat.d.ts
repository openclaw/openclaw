import type { Model } from "@mariozechner/pi-ai";
import type { ProviderEndpointClass, ProviderRequestCapabilities } from "./provider-attribution.js";
type OpenAICompletionsCompatDefaultsInput = {
    provider?: string;
    endpointClass: ProviderEndpointClass;
    knownProviderFamily: string;
    supportsNativeStreamingUsageCompat?: boolean;
    supportsOpenAICompletionsStreamingUsageCompat?: boolean;
    usesExplicitProxyLikeEndpoint?: boolean;
};
type OpenAICompletionsCompatDefaults = {
    supportsStore: boolean;
    supportsDeveloperRole: boolean;
    supportsReasoningEffort: boolean;
    supportsUsageInStreaming: boolean;
    maxTokensField: "max_completion_tokens" | "max_tokens";
    thinkingFormat: "openai" | "openrouter" | "deepseek" | "zai";
    visibleReasoningDetailTypes: string[];
    supportsStrictMode: boolean;
};
type DetectedOpenAICompletionsCompat = {
    capabilities: ProviderRequestCapabilities;
    defaults: OpenAICompletionsCompatDefaults;
};
export declare function resolveOpenAICompletionsCompatDefaults(input: OpenAICompletionsCompatDefaultsInput): OpenAICompletionsCompatDefaults;
export declare function detectOpenAICompletionsCompat(model: Pick<Model<"openai-completions">, "provider" | "baseUrl" | "id"> & {
    compat?: {
        supportsStore?: boolean;
    } | null;
}): DetectedOpenAICompletionsCompat;
export {};
