export type AnthropicServiceTier = "auto" | "standard_only";
export type AnthropicEphemeralCacheControl = {
    type: "ephemeral";
    ttl?: "1h";
};
type AnthropicPayloadPolicyInput = {
    api?: string;
    baseUrl?: string;
    cacheRetention?: "short" | "long" | "none";
    enableCacheControl?: boolean;
    provider?: string;
    serviceTier?: AnthropicServiceTier;
};
export type AnthropicPayloadPolicy = {
    allowsServiceTier: boolean;
    cacheControl: AnthropicEphemeralCacheControl | undefined;
    serviceTier: AnthropicServiceTier | undefined;
};
export declare function resolveAnthropicPayloadPolicy(input: AnthropicPayloadPolicyInput): AnthropicPayloadPolicy;
export declare function applyAnthropicPayloadPolicyToParams(payloadObj: Record<string, unknown>, policy: AnthropicPayloadPolicy): void;
export declare function applyAnthropicEphemeralCacheControlMarkers(payloadObj: Record<string, unknown>): void;
export {};
