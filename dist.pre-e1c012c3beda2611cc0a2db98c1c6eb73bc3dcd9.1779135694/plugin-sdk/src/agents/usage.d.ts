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
    input_tokens_details?: {
        cached_tokens?: number;
    };
    prompt_tokens_details?: {
        cached_tokens?: number;
    };
    totalTokens?: number;
    total_tokens?: number;
    cache_read?: number;
    cache_write?: number;
    prompt_n?: number;
    predicted_n?: number;
    timings?: {
        prompt_n?: number;
        predicted_n?: number;
    };
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
/**
 * Maps normalized usage to OpenAI Chat Completions `usage` fields.
 *
 * `prompt_tokens` is input + cacheRead (cache write is excluded to match the
 * OpenAI-style breakdown used by the compat endpoint).
 *
 * `total_tokens` is the greater of the component sum and aggregate `total` when
 * present, so a partial breakdown cannot discard a valid upstream total.
 */
export declare function toOpenAiChatCompletionsUsage(usage: NormalizedUsage | undefined): {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
};
export declare function derivePromptTokens(usage?: {
    input?: number;
    cacheRead?: number;
    cacheWrite?: number;
}): number | undefined;
export declare function deriveContextPromptTokens(params: {
    lastCallUsage?: NormalizedUsage;
    promptTokens?: number;
    usage?: NormalizedUsage;
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
