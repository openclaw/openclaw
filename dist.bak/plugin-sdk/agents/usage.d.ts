export type UsageLike = {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
    inputTokens?: number;
    outputTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cached_tokens?: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
    };
    totalTokens?: number;
    total_tokens?: number;
    cache_read?: number;
    cache_write?: number;
};
export type NormalizedUsage = {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
};
export type AssistantUsageSnapshot = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
};
export declare function makeZeroUsageSnapshot(): AssistantUsageSnapshot;
export declare function hasNonzeroUsage(usage?: NormalizedUsage | null): usage is NormalizedUsage;
export declare function normalizeUsage(raw?: UsageLike | null): NormalizedUsage | undefined;
export declare function derivePromptTokens(usage?: {
    input?: number;
    cacheRead?: number;
    cacheWrite?: number;
}): number | undefined;
export declare function deriveSessionTotalTokens(params: {
    usage?: {
        input?: number;
        output?: number;
        total?: number;
        cacheRead?: number;
        cacheWrite?: number;
    };
    contextTokens?: number;
    promptTokens?: number;
}): number | undefined;
