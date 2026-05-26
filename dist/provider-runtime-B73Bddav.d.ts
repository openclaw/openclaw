import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { u as ModelProviderConfig } from "./types.models-tqxsISRc.js";
import { n as FailoverReason } from "./types-DKoVBm0H.js";
import { t as ModelCatalogEntry } from "./model-catalog.types-LYni1Yjz.js";
import { c as OAuthCredential, i as AuthProfileCredential } from "./types-BwDj5PsX.js";
import { r as AnyAgentTool } from "./common-BDN0bXby.js";
import { $n as ProviderExternalAuthProfile, $t as ProviderModernModelPolicyContext, An as ProviderResolveTransportTurnStateContext, Bn as ProviderValidateReplayTurnsContext, Bt as ProviderCreateEmbeddingProviderContext, Ct as ProviderAugmentModelCatalogContext, Dn as ProviderResolveDynamicModelContext, Fn as ProviderSanitizeReplayHistoryContext, Ft as ProviderCacheTtlEligibilityContext, Ht as ProviderDeferSyntheticProfileAuthContext, In as ProviderSystemPromptContributionContext, Jt as ProviderFailoverErrorContext, Ln as ProviderToolSchemaDiagnostic, Mn as ProviderResolveWebSocketSessionPolicyContext, Mt as ProviderBuildUnknownModelHintContext, Nn as ProviderResolvedUsageAuth, Qn as ProviderRuntimeModel, Rn as ProviderTransformSystemPromptContext, Tt as ProviderAuthDoctorHintContext, Vn as ProviderWebSocketSessionPolicy, Vt as ProviderCreateStreamFnContext, Xn as ProviderThinkingPolicyContext, Yn as ProviderDefaultThinkingPolicyContext, Yt as ProviderFetchUsageSnapshotContext, Zn as ProviderThinkingProfile, _n as ProviderPreparedRuntimeAuth, an as ProviderNormalizeTransportContext, ar as ProviderApplyConfigDefaultsContext, bn as ProviderReplayPolicy, dt as PluginEmbeddingProvider, gn as ProviderPrepareRuntimeAuthContext, in as ProviderNormalizeToolSchemasContext, ir as ProviderSyntheticAuthResult, jn as ProviderResolveUsageAuthContext, jt as ProviderBuildMissingAuthMessageContext, mn as ProviderPrepareDynamicModelContext, nn as ProviderNormalizeModelIdContext, nr as ProviderResolveExternalOAuthProfilesContext, oi as ProviderSystemPromptContribution, or as ProviderNormalizeConfigContext, pn as ProviderPreferRuntimeResolvedModelContext, rn as ProviderNormalizeResolvedModelContext, rr as ProviderResolveSyntheticAuthContext, sr as ProviderResolveConfigApiKeyContext, tr as ProviderResolveExternalAuthProfilesContext, vn as ProviderReasoningOutputMode, wr as PluginTextTransforms, xn as ProviderReplayPolicyContext, yn as ProviderReasoningOutputModeContext, zn as ProviderTransportTurnState } from "./types-Vx7Jq4_-2.js";
import { t as ProviderUsageSnapshot } from "./provider-usage.types-BGbkzahX.js";
import { a as resolveProviderFollowupFallbackRoute, i as resolveProviderExtraParamsForTransport, n as prepareProviderExtraParams, o as resolveProviderRuntimePlugin, r as resolveProviderAuthProfileId, s as wrapProviderStreamFn, t as ProviderRuntimePluginHandle } from "./provider-hook-runtime-5QGHpPQz.js";

//#region src/plugins/provider-runtime.d.ts
declare namespace provider_runtime_d_exports {
  export { testing as __testing, applyProviderConfigDefaultsWithPlugin, applyProviderNativeStreamingUsageCompatWithPlugin, applyProviderResolvedModelCompatWithPlugins, applyProviderResolvedTransportWithPlugin, augmentModelCatalogWithProviderPlugins, buildProviderAuthDoctorHintWithPlugin, buildProviderMissingAuthMessageWithPlugin, buildProviderUnknownModelHintWithPlugin, classifyProviderFailoverReasonWithPlugin, createProviderEmbeddingProvider, formatProviderAuthProfileApiKeyWithPlugin, inspectProviderToolSchemasWithPlugin, matchesProviderContextOverflowWithPlugin, normalizeProviderConfigWithPlugin, normalizeProviderModelIdWithPlugin, normalizeProviderResolvedModelWithPlugin, normalizeProviderToolSchemasWithPlugin, normalizeProviderTransportWithPlugin, prepareProviderDynamicModel, prepareProviderExtraParams, prepareProviderRuntimeAuth, refreshProviderOAuthCredentialWithPlugin, resolveExternalAuthProfilesWithPlugins, resolveExternalOAuthProfilesWithPlugins, resolveProviderAuthProfileId, resolveProviderBinaryThinking, resolveProviderCacheTtlEligibility, resolveProviderConfigApiKeyWithPlugin, resolveProviderDefaultThinkingLevel, resolveProviderExtraParamsForTransport, resolveProviderFollowupFallbackRoute, resolveProviderModernModelRef, resolveProviderReasoningOutputModeWithPlugin, resolveProviderReplayPolicyWithPlugin, resolveProviderRuntimePlugin, resolveProviderStreamFn, resolveProviderSyntheticAuthWithPlugin, resolveProviderSystemPromptContribution, resolveProviderTextTransforms, resolveProviderThinkingProfile, resolveProviderTransportTurnStateWithPlugin, resolveProviderUsageAuthWithPlugin, resolveProviderUsageSnapshotWithPlugin, resolveProviderWebSocketSessionPolicyWithPlugin, resolveProviderXHighThinking, runProviderDynamicModel, sanitizeProviderReplayHistoryWithPlugin, shouldDeferProviderSyntheticProfileAuthWithPlugin, shouldPreferProviderRuntimeResolvedModel, testing, transformProviderSystemPrompt, validateProviderReplayTurnsWithPlugin, wrapProviderStreamFn };
}
declare function resetExternalAuthFallbackWarningCacheForTest(): void;
declare const testing: {
  readonly resetExternalAuthFallbackWarningCacheForTest: typeof resetExternalAuthFallbackWarningCacheForTest;
};
declare function runProviderDynamicModel(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveDynamicModelContext;
}): ProviderRuntimeModel | undefined;
declare function resolveProviderSystemPromptContribution(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  context: ProviderSystemPromptContributionContext;
}): ProviderSystemPromptContribution | undefined;
declare function transformProviderSystemPrompt(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  context: ProviderTransformSystemPromptContext;
}): string;
declare function resolveProviderTextTransforms(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
}): PluginTextTransforms | undefined;
declare function prepareProviderDynamicModel(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderPrepareDynamicModelContext;
}): Promise<void>;
declare function shouldPreferProviderRuntimeResolvedModel(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderPreferRuntimeResolvedModelContext;
}): boolean;
declare function normalizeProviderResolvedModelWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: {
    config?: OpenClawConfig;
    agentDir?: string;
    workspaceDir?: string;
    provider: string;
    modelId: string;
    model: ProviderRuntimeModel;
  };
}): ProviderRuntimeModel | undefined;
declare function applyProviderResolvedModelCompatWithPlugins(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderNormalizeResolvedModelContext;
}): ProviderRuntimeModel | undefined;
declare function applyProviderResolvedTransportWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderNormalizeResolvedModelContext;
}): ProviderRuntimeModel | undefined;
declare function normalizeProviderModelIdWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderNormalizeModelIdContext;
}): string | undefined;
declare function normalizeProviderTransportWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderNormalizeTransportContext;
}): {
  api?: string | null;
  baseUrl?: string;
} | undefined;
declare function normalizeProviderConfigWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderNormalizeConfigContext;
  allowRuntimePluginLoad?: boolean;
}): ModelProviderConfig | undefined;
declare function applyProviderNativeStreamingUsageCompatWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderNormalizeConfigContext;
  allowRuntimePluginLoad?: boolean;
}): ModelProviderConfig | undefined;
declare function resolveProviderConfigApiKeyWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveConfigApiKeyContext;
  allowRuntimePluginLoad?: boolean;
}): string | undefined;
declare function resolveProviderReplayPolicyWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderReplayPolicyContext;
}): ProviderReplayPolicy | undefined;
declare function sanitizeProviderReplayHistoryWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderSanitizeReplayHistoryContext;
}): Promise<import("@earendil-works/pi-agent-core").AgentMessage[] | null | undefined>;
declare function validateProviderReplayTurnsWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderValidateReplayTurnsContext;
}): Promise<import("@earendil-works/pi-agent-core").AgentMessage[] | null | undefined>;
declare function normalizeProviderToolSchemasWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  context: ProviderNormalizeToolSchemasContext;
}): AnyAgentTool[] | undefined;
declare function inspectProviderToolSchemasWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  context: ProviderNormalizeToolSchemasContext;
}): ProviderToolSchemaDiagnostic[] | undefined;
declare function resolveProviderReasoningOutputModeWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderReasoningOutputModeContext;
}): ProviderReasoningOutputMode | undefined;
declare function resolveProviderStreamFn(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  allowRuntimePluginLoad?: boolean;
  context: ProviderCreateStreamFnContext;
}): import("@earendil-works/pi-agent-core").StreamFn | undefined;
declare function resolveProviderTransportTurnStateWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveTransportTurnStateContext;
}): ProviderTransportTurnState | undefined;
declare function resolveProviderWebSocketSessionPolicyWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveWebSocketSessionPolicyContext;
}): ProviderWebSocketSessionPolicy | undefined;
declare function createProviderEmbeddingProvider(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderCreateEmbeddingProviderContext;
}): Promise<PluginEmbeddingProvider | null | undefined>;
declare function prepareProviderRuntimeAuth(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderPrepareRuntimeAuthContext;
}): Promise<ProviderPreparedRuntimeAuth | null | undefined>;
declare function resolveProviderUsageAuthWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveUsageAuthContext;
}): Promise<ProviderResolvedUsageAuth | null | undefined>;
declare function resolveProviderUsageSnapshotWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderFetchUsageSnapshotContext;
}): Promise<ProviderUsageSnapshot | null | undefined>;
declare function matchesProviderContextOverflowWithPlugin(params: {
  provider?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderFailoverErrorContext;
}): boolean;
declare function classifyProviderFailoverReasonWithPlugin(params: {
  provider?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderFailoverErrorContext;
}): FailoverReason | undefined;
declare function formatProviderAuthProfileApiKeyWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: AuthProfileCredential;
}): string | undefined;
declare function refreshProviderOAuthCredentialWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: OAuthCredential;
}): Promise<OAuthCredential | undefined>;
declare function buildProviderAuthDoctorHintWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderAuthDoctorHintContext;
}): Promise<string | null | undefined>;
declare function resolveProviderCacheTtlEligibility(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderCacheTtlEligibilityContext;
}): boolean | undefined;
declare function resolveProviderBinaryThinking(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderThinkingPolicyContext;
}): boolean | undefined;
declare function resolveProviderXHighThinking(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderThinkingPolicyContext;
}): boolean | undefined;
declare function resolveProviderThinkingProfile(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderDefaultThinkingPolicyContext;
}): ProviderThinkingProfile | null | undefined;
declare function resolveProviderDefaultThinkingLevel(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderDefaultThinkingPolicyContext;
}): "off" | "minimal" | "high" | "low" | "medium" | "xhigh" | "adaptive" | null | undefined;
declare function applyProviderConfigDefaultsWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderApplyConfigDefaultsContext;
}): OpenClawConfig | undefined;
declare function resolveProviderModernModelRef(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderModernModelPolicyContext;
}): boolean | undefined;
declare function buildProviderMissingAuthMessageWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderBuildMissingAuthMessageContext;
}): string | undefined;
declare function buildProviderUnknownModelHintWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderBuildUnknownModelHintContext;
}): string | undefined;
declare function resolveProviderSyntheticAuthWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveSyntheticAuthContext;
  modelApi?: string;
}): ProviderSyntheticAuthResult | null | undefined;
declare function resolveExternalAuthProfilesWithPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveExternalAuthProfilesContext;
}): ProviderExternalAuthProfile[];
declare function resolveExternalOAuthProfilesWithPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveExternalOAuthProfilesContext;
}): ProviderExternalAuthProfile[];
declare function shouldDeferProviderSyntheticProfileAuthWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderDeferSyntheticProfileAuthContext;
  modelApi?: string;
}): boolean | undefined;
declare function augmentModelCatalogWithProviderPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderAugmentModelCatalogContext;
}): Promise<ModelCatalogEntry[]>;
//#endregion
export { normalizeProviderResolvedModelWithPlugin as a, provider_runtime_d_exports as c, buildProviderUnknownModelHintWithPlugin as i, runProviderDynamicModel as l, applyProviderResolvedTransportWithPlugin as n, normalizeProviderTransportWithPlugin as o, augmentModelCatalogWithProviderPlugins as r, prepareProviderDynamicModel as s, applyProviderResolvedModelCompatWithPlugins as t, shouldPreferProviderRuntimeResolvedModel as u };