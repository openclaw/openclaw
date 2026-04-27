type OpenAIResponsesPayloadModel = {
    api?: unknown;
    baseUrl?: unknown;
    id?: unknown;
    provider?: unknown;
    contextWindow?: unknown;
    compat?: unknown;
};
type OpenAIResponsesPayloadPolicyOptions = {
    extraParams?: Record<string, unknown>;
    storeMode?: "provider-policy" | "disable" | "preserve";
    enablePromptCacheStripping?: boolean;
    enableServerCompaction?: boolean;
};
export type OpenAIResponsesPayloadPolicy = {
    allowsServiceTier: boolean;
    compactThreshold: number;
    explicitStore: boolean | undefined;
    shouldStripDisabledReasoningPayload: boolean;
    shouldStripPromptCache: boolean;
    shouldStripStore: boolean;
    useServerCompaction: boolean;
};
export declare function resolveOpenAIResponsesPayloadPolicy(model: OpenAIResponsesPayloadModel, options?: OpenAIResponsesPayloadPolicyOptions): OpenAIResponsesPayloadPolicy;
export declare function applyOpenAIResponsesPayloadPolicy(payloadObj: Record<string, unknown>, policy: OpenAIResponsesPayloadPolicy): void;
export {};
