import type { Api } from "@mariozechner/pi-ai";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.js";
export type InlineModelEntry = Omit<ModelDefinitionConfig, "api"> & {
    api?: Api;
    provider: string;
    baseUrl?: string;
    headers?: Record<string, string>;
};
export type InlineProviderConfig = {
    baseUrl?: string;
    api?: ModelDefinitionConfig["api"];
    models?: ModelDefinitionConfig[];
    contextWindow?: ModelProviderConfig["contextWindow"];
    contextTokens?: ModelProviderConfig["contextTokens"];
    maxTokens?: ModelProviderConfig["maxTokens"];
    headers?: unknown;
    authHeader?: boolean;
    timeoutSeconds?: ModelProviderConfig["timeoutSeconds"];
    request?: ModelProviderConfig["request"];
};
export declare function normalizeResolvedTransportApi(api: unknown): ModelDefinitionConfig["api"] | undefined;
export declare function sanitizeModelHeaders(headers: unknown, opts?: {
    stripSecretRefMarkers?: boolean;
}): Record<string, string> | undefined;
export declare function resolveProviderModelInput(params: {
    provider?: string;
    modelId?: string;
    modelName?: string;
    input?: unknown;
    fallbackInput?: unknown;
}): Array<"text" | "image">;
export declare function buildInlineProviderModels(providers: Record<string, InlineProviderConfig>): InlineModelEntry[];
