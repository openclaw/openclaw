/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
export type AnthropicServiceTier = "auto" | "standard_only";
/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
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
/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
export type AnthropicPayloadPolicy = {
    allowsServiceTier: boolean;
    cacheControl: AnthropicEphemeralCacheControl | undefined;
    serviceTier: AnthropicServiceTier | undefined;
};
/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
export declare function resolveAnthropicPayloadPolicy(input: AnthropicPayloadPolicyInput): AnthropicPayloadPolicy;
/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
export declare function applyAnthropicPayloadPolicyToParams(payloadObj: Record<string, unknown>, policy: AnthropicPayloadPolicy): void;
/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
export declare function applyAnthropicEphemeralCacheControlMarkers(payloadObj: Record<string, unknown>): void;
export {};
