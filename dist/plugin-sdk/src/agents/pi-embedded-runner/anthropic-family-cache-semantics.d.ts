type AnthropicCacheRetentionFamily = "anthropic-direct" | "anthropic-bedrock" | "custom-anthropic-api";
export declare function isAnthropicModelRef(modelId: string): boolean;
export declare function isAnthropicBedrockModel(modelId: string): boolean;
export declare function isOpenRouterAnthropicModelRef(provider: string, modelId: string): boolean;
export declare function isAnthropicFamilyCacheTtlEligible(params: {
    provider: string;
    modelApi?: string;
    modelId: string;
}): boolean;
export declare function resolveAnthropicCacheRetentionFamily(params: {
    provider: string;
    modelApi?: string;
    modelId?: string;
    hasExplicitCacheConfig: boolean;
}): AnthropicCacheRetentionFamily | undefined;
export {};
