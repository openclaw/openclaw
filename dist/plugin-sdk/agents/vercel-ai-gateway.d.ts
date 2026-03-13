import type { ModelDefinitionConfig } from "../config/types.models.js";
export declare const VERCEL_AI_GATEWAY_PROVIDER_ID = "vercel-ai-gateway";
export declare const VERCEL_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
export declare const VERCEL_AI_GATEWAY_DEFAULT_MODEL_ID = "anthropic/claude-opus-4.6";
export declare const VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF = "vercel-ai-gateway/anthropic/claude-opus-4.6";
export declare const VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW = 200000;
export declare const VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS = 128000;
export declare const VERCEL_AI_GATEWAY_DEFAULT_COST: {
    readonly input: 0;
    readonly output: 0;
    readonly cacheRead: 0;
    readonly cacheWrite: 0;
};
export declare function getStaticVercelAiGatewayModelCatalog(): ModelDefinitionConfig[];
export declare function discoverVercelAiGatewayModels(): Promise<ModelDefinitionConfig[]>;
