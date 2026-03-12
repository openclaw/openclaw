import type { ModelDefinitionConfig } from "../config/types.js";
export declare const CLOUDFLARE_AI_GATEWAY_PROVIDER_ID = "cloudflare-ai-gateway";
export declare const CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_ID = "claude-sonnet-4-5";
export declare const CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF = "cloudflare-ai-gateway/claude-sonnet-4-5";
export declare const CLOUDFLARE_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW = 200000;
export declare const CLOUDFLARE_AI_GATEWAY_DEFAULT_MAX_TOKENS = 64000;
export declare const CLOUDFLARE_AI_GATEWAY_DEFAULT_COST: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
};
export declare function buildCloudflareAiGatewayModelDefinition(params?: {
    id?: string;
    name?: string;
    reasoning?: boolean;
    input?: Array<"text" | "image">;
}): ModelDefinitionConfig;
export declare function resolveCloudflareAiGatewayBaseUrl(params: {
    accountId: string;
    gatewayId: string;
}): string;
