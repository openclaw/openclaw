export type ProviderCapabilities = {
    anthropicToolSchemaMode: "native" | "openai-functions";
    anthropicToolChoiceMode: "native" | "openai-string-modes";
    providerFamily: "default" | "openai" | "anthropic";
    preserveAnthropicThinkingSignatures: boolean;
    openAiCompatTurnValidation: boolean;
    geminiThoughtSignatureSanitization: boolean;
    transcriptToolCallIdMode: "default" | "strict9";
    transcriptToolCallIdModelHints: string[];
    geminiThoughtSignatureModelHints: string[];
    dropThinkingBlockModelHints: string[];
};
export declare function resolveProviderCapabilities(provider?: string | null): ProviderCapabilities;
export declare function preservesAnthropicThinkingSignatures(provider?: string | null): boolean;
export declare function requiresOpenAiCompatibleAnthropicToolPayload(provider?: string | null): boolean;
export declare function usesOpenAiFunctionAnthropicToolSchema(provider?: string | null): boolean;
export declare function usesOpenAiStringModeAnthropicToolChoice(provider?: string | null): boolean;
export declare function supportsOpenAiCompatTurnValidation(provider?: string | null): boolean;
export declare function sanitizesGeminiThoughtSignatures(provider?: string | null): boolean;
export declare function isOpenAiProviderFamily(provider?: string | null): boolean;
export declare function isAnthropicProviderFamily(provider?: string | null): boolean;
export declare function shouldDropThinkingBlocksForModel(params: {
    provider?: string | null;
    modelId?: string | null;
}): boolean;
export declare function shouldSanitizeGeminiThoughtSignaturesForModel(params: {
    provider?: string | null;
    modelId?: string | null;
}): boolean;
export declare function resolveTranscriptToolCallIdMode(provider?: string | null, modelId?: string | null): "strict9" | undefined;
