import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { p as AgentModelConfig } from "./types.models-CkWCv1xp.js";
import { t as FallbackAttempt } from "./model-fallback.types-DqpQNmXU.js";
import { n as MediaNormalizationEntry, r as MediaNormalizationValue, t as MediaGenerationNormalizationMetadataInput } from "./normalization.types-CG6XXF7L.js";
import { n as getProviderEnvVars } from "./provider-env-vars-Dh_vzkBY.js";

//#region src/media-generation/runtime-shared.d.ts
type ParsedProviderModelRef = {
  provider: string;
  model: string;
};
declare function recordCapabilityCandidateFailure(params: {
  attempts: FallbackAttempt[];
  provider: string;
  model: string;
  error: unknown;
}): void;
declare function hasMediaNormalizationEntry<TValue extends MediaNormalizationValue>(entry: MediaNormalizationEntry<TValue> | undefined): entry is MediaNormalizationEntry<TValue>;
type CapabilityProviderCandidate = {
  id: string;
  aliases?: readonly string[];
  defaultModel?: string | null;
  models?: readonly string[];
  isConfigured?: (ctx: {
    cfg?: OpenClawConfig;
    agentDir?: string;
  }) => boolean;
};
declare function resolveCapabilityModelCandidates(params: {
  cfg: OpenClawConfig;
  modelConfig: AgentModelConfig | undefined;
  modelOverride?: string;
  parseModelRef: (raw: string | undefined) => ParsedProviderModelRef | null;
  agentDir?: string;
  listProviders?: (cfg?: OpenClawConfig) => CapabilityProviderCandidate[];
  autoProviderFallback?: boolean;
}): ParsedProviderModelRef[];
declare function deriveAspectRatioFromSize(size?: string): string | undefined;
declare function resolveClosestAspectRatio(params: {
  requestedAspectRatio?: string;
  requestedSize?: string;
  supportedAspectRatios?: readonly string[];
}): string | undefined;
declare function resolveClosestSize(params: {
  requestedSize?: string;
  requestedAspectRatio?: string;
  supportedSizes?: readonly string[];
}): string | undefined;
declare function resolveClosestResolution<TResolution extends string>(params: {
  requestedResolution?: TResolution;
  supportedResolutions?: readonly TResolution[];
  order?: readonly TResolution[];
}): TResolution | undefined;
declare function normalizeDurationToClosestMax(durationSeconds?: number, maxDurationSeconds?: number): number | undefined;
declare function buildMediaGenerationNormalizationMetadata(params: {
  normalization?: MediaGenerationNormalizationMetadataInput;
  requestedSizeForDerivedAspectRatio?: string;
  includeSupportedDurationSeconds?: boolean;
}): Record<string, unknown>;
declare function throwCapabilityGenerationFailure(params: {
  capabilityLabel: string;
  attempts: FallbackAttempt[];
  lastError: unknown;
}): never;
declare function buildNoCapabilityModelConfiguredMessage(params: {
  capabilityLabel: string;
  modelConfigKey: string;
  providers: Array<{
    id: string;
    defaultModel?: string | null;
  }>;
  fallbackSampleRef?: string;
  getProviderEnvVars?: typeof getProviderEnvVars;
}): string;
//#endregion
export { hasMediaNormalizationEntry as a, resolveCapabilityModelCandidates as c, resolveClosestSize as d, throwCapabilityGenerationFailure as f, deriveAspectRatioFromSize as i, resolveClosestAspectRatio as l, buildMediaGenerationNormalizationMetadata as n, normalizeDurationToClosestMax as o, buildNoCapabilityModelConfiguredMessage as r, recordCapabilityCandidateFailure as s, ParsedProviderModelRef as t, resolveClosestResolution as u };