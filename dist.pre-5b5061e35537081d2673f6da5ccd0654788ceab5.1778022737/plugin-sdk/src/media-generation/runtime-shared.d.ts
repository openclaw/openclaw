import type { FallbackAttempt } from "../agents/model-fallback.types.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.js";
import { getProviderEnvVars as getDefaultProviderEnvVars } from "../secrets/provider-env-vars.js";
import type { MediaGenerationNormalizationMetadataInput, MediaNormalizationEntry, MediaNormalizationValue } from "./normalization.types.js";
export type ParsedProviderModelRef = {
    provider: string;
    model: string;
};
export type { MediaGenerationNormalizationMetadataInput, MediaNormalizationEntry, MediaNormalizationValue, } from "./normalization.types.js";
export declare function recordCapabilityCandidateFailure(params: {
    attempts: FallbackAttempt[];
    provider: string;
    model: string;
    error: unknown;
}): void;
export declare function hasMediaNormalizationEntry<TValue extends MediaNormalizationValue>(entry: MediaNormalizationEntry<TValue> | undefined): entry is MediaNormalizationEntry<TValue>;
type CapabilityProviderCandidate = {
    id: string;
    aliases?: readonly string[];
    defaultModel?: string | null;
    isConfigured?: (ctx: {
        cfg?: OpenClawConfig;
        agentDir?: string;
    }) => boolean;
};
export declare function resolveCapabilityModelCandidates(params: {
    cfg: OpenClawConfig;
    modelConfig: AgentModelConfig | undefined;
    modelOverride?: string;
    parseModelRef: (raw: string | undefined) => ParsedProviderModelRef | null;
    agentDir?: string;
    listProviders?: (cfg?: OpenClawConfig) => CapabilityProviderCandidate[];
    autoProviderFallback?: boolean;
}): ParsedProviderModelRef[];
export declare function deriveAspectRatioFromSize(size?: string): string | undefined;
export declare function resolveClosestAspectRatio(params: {
    requestedAspectRatio?: string;
    requestedSize?: string;
    supportedAspectRatios?: readonly string[];
}): string | undefined;
export declare function resolveClosestSize(params: {
    requestedSize?: string;
    requestedAspectRatio?: string;
    supportedSizes?: readonly string[];
}): string | undefined;
export declare function resolveClosestResolution<TResolution extends string>(params: {
    requestedResolution?: TResolution;
    supportedResolutions?: readonly TResolution[];
    order?: readonly TResolution[];
}): TResolution | undefined;
export declare function normalizeDurationToClosestMax(durationSeconds?: number, maxDurationSeconds?: number): number | undefined;
export declare function buildMediaGenerationNormalizationMetadata(params: {
    normalization?: MediaGenerationNormalizationMetadataInput;
    requestedSizeForDerivedAspectRatio?: string;
    includeSupportedDurationSeconds?: boolean;
}): Record<string, unknown>;
export declare function throwCapabilityGenerationFailure(params: {
    capabilityLabel: string;
    attempts: FallbackAttempt[];
    lastError: unknown;
}): never;
export declare function buildNoCapabilityModelConfiguredMessage(params: {
    capabilityLabel: string;
    modelConfigKey: string;
    providers: Array<{
        id: string;
        defaultModel?: string | null;
    }>;
    fallbackSampleRef?: string;
    getProviderEnvVars?: typeof getDefaultProviderEnvVars;
}): string;
