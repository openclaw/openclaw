import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type SecretInput } from "../config/types.secrets.js";
export type CustomModelImageInputInference = {
    supportsImageInput: boolean;
    confidence: "known" | "unknown";
};
export declare function resolveCustomModelImageInputInference(modelId: string): CustomModelImageInputInference;
export declare function inferCustomModelSupportsImageInput(modelId: string): boolean;
export type CustomApiCompatibility = "openai" | "anthropic";
export type CustomApiResult = {
    config: OpenClawConfig;
    providerId?: string;
    modelId?: string;
    providerIdRenamedFrom?: string;
};
export type ApplyCustomApiConfigParams = {
    config: OpenClawConfig;
    baseUrl: string;
    modelId: string;
    compatibility: CustomApiCompatibility;
    apiKey?: SecretInput;
    providerId?: string;
    alias?: string;
    supportsImageInput?: boolean;
};
export type ParseNonInteractiveCustomApiFlagsParams = {
    baseUrl?: string;
    modelId?: string;
    compatibility?: string;
    apiKey?: string;
    providerId?: string;
    supportsImageInput?: boolean;
};
export type ParsedNonInteractiveCustomApiFlags = {
    baseUrl: string;
    modelId: string;
    compatibility: CustomApiCompatibility;
    apiKey?: string;
    providerId?: string;
    supportsImageInput?: boolean;
};
export type CustomApiErrorCode = "missing_required" | "invalid_compatibility" | "invalid_base_url" | "invalid_model_id" | "invalid_provider_id" | "invalid_alias";
export declare class CustomApiError extends Error {
    readonly code: CustomApiErrorCode;
    constructor(code: CustomApiErrorCode, message: string);
}
export type ResolveCustomProviderIdParams = {
    config: OpenClawConfig;
    baseUrl: string;
    providerId?: string;
};
export type ResolvedCustomProviderId = {
    providerId: string;
    providerIdRenamedFrom?: string;
};
export declare function normalizeEndpointId(raw: string): string;
export declare function buildEndpointIdFromUrl(baseUrl: string): string;
export declare function resolveCustomModelAliasError(params: {
    raw: string;
    cfg: OpenClawConfig;
    modelRef: string;
}): string | undefined;
type VerificationRequest = {
    endpoint: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
};
export declare function normalizeOptionalProviderApiKey(value: unknown): SecretInput | undefined;
export declare function buildOpenAiVerificationProbeRequest(params: {
    baseUrl: string;
    apiKey: string;
    modelId: string;
}): VerificationRequest;
export declare function buildAnthropicVerificationProbeRequest(params: {
    baseUrl: string;
    apiKey: string;
    modelId: string;
}): VerificationRequest;
export declare function resolveCustomProviderId(params: ResolveCustomProviderIdParams): ResolvedCustomProviderId;
export declare function parseNonInteractiveCustomApiFlags(params: ParseNonInteractiveCustomApiFlagsParams): ParsedNonInteractiveCustomApiFlags;
export declare function applyCustomApiConfig(params: ApplyCustomApiConfigParams): CustomApiResult;
export {};
