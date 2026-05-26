import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { l as ModelProviderConfig } from "./types.models-CkWCv1xp.js";
import { n as FailoverReason } from "./types-CqYXTtzA.js";
import { t as ModelCatalogEntry } from "./model-catalog.types-CRpxx7uE.js";
import { c as OAuthCredential, i as AuthProfileCredential } from "./types-Biu67nNB.js";
import { r as AnyAgentTool } from "./common-5s-NiX7e.js";
import { $n as ProviderSyntheticAuthResult, $t as ProviderNormalizeToolSchemasContext, An as ProviderSanitizeReplayHistoryContext, At as ProviderCacheTtlEligibilityContext, Dn as ProviderResolveWebSocketSessionPolicyContext, Dt as ProviderBuildUnknownModelHintContext, En as ProviderResolveUsageAuthContext, Et as ProviderBuildMissingAuthMessageContext, Fn as ProviderValidateReplayTurnsContext, Ft as ProviderCreateEmbeddingProviderContext, Gn as ProviderThinkingPolicyContext, In as ProviderWebSocketSessionPolicy, It as ProviderCreateStreamFnContext, Jn as ProviderExternalAuthProfile, Jt as ProviderModernModelPolicyContext, Kn as ProviderThinkingProfile, Lt as ProviderDeferSyntheticProfileAuthContext, Mn as ProviderToolSchemaDiagnostic, Nn as ProviderTransformSystemPromptContext, On as ProviderResolvedUsageAuth, Pn as ProviderTransportTurnState, Qn as ProviderResolveSyntheticAuthContext, Qt as ProviderNormalizeResolvedModelContext, Sn as ProviderResolveDynamicModelContext, Tn as ProviderResolveTransportTurnStateContext, Ut as ProviderFailoverErrorContext, Wn as ProviderDefaultThinkingPolicyContext, Wt as ProviderFetchUsageSnapshotContext, Xn as ProviderResolveExternalAuthProfilesContext, Zn as ProviderResolveExternalOAuthProfilesContext, Zt as ProviderNormalizeModelIdContext, bt as ProviderAuthDoctorHintContext, cn as ProviderPreferRuntimeResolvedModelContext, dn as ProviderPrepareRuntimeAuthContext, en as ProviderNormalizeTransportContext, er as ProviderApplyConfigDefaultsContext, fn as ProviderPreparedRuntimeAuth, gn as ProviderReplayPolicyContext, hn as ProviderReplayPolicy, jn as ProviderSystemPromptContributionContext, ln as ProviderPrepareDynamicModelContext, mn as ProviderReasoningOutputModeContext, nr as ProviderResolveConfigApiKeyContext, ot as PluginEmbeddingProvider, pn as ProviderReasoningOutputMode, qn as ProviderRuntimeModel, ti as ProviderSystemPromptContribution, tr as ProviderNormalizeConfigContext, vt as ProviderAugmentModelCatalogContext, yr as PluginTextTransforms } from "./types-lCXG2pW_.js";
import { t as ProviderUsageSnapshot } from "./provider-usage.types-sIcnGsOF.js";
import { a as resolveProviderFollowupFallbackRoute, i as resolveProviderExtraParamsForTransport, n as prepareProviderExtraParams, o as resolveProviderRuntimePlugin, r as resolveProviderAuthProfileId, s as wrapProviderStreamFn, t as ProviderRuntimePluginHandle } from "./provider-hook-runtime-C5Q8sF1-.js";
import * as _$_earendil_works_pi_agent_core0 from "@earendil-works/pi-agent-core";

//#region src/plugins/provider-runtime.d.ts
declare namespace provider_runtime_d_exports {
  export { __testing, applyProviderConfigDefaultsWithPlugin, applyProviderNativeStreamingUsageCompatWithPlugin, applyProviderResolvedModelCompatWithPlugins, applyProviderResolvedTransportWithPlugin, augmentModelCatalogWithProviderPlugins, buildProviderAuthDoctorHintWithPlugin, buildProviderMissingAuthMessageWithPlugin, buildProviderUnknownModelHintWithPlugin, classifyProviderFailoverReasonWithPlugin, createProviderEmbeddingProvider, formatProviderAuthProfileApiKeyWithPlugin, inspectProviderToolSchemasWithPlugin, matchesProviderContextOverflowWithPlugin, normalizeProviderConfigWithPlugin, normalizeProviderModelIdWithPlugin, normalizeProviderResolvedModelWithPlugin, normalizeProviderToolSchemasWithPlugin, normalizeProviderTransportWithPlugin, prepareProviderDynamicModel, prepareProviderExtraParams, prepareProviderRuntimeAuth, refreshProviderOAuthCredentialWithPlugin, resolveExternalAuthProfilesWithPlugins, resolveExternalOAuthProfilesWithPlugins, resolveProviderAuthProfileId, resolveProviderBinaryThinking, resolveProviderCacheTtlEligibility, resolveProviderConfigApiKeyWithPlugin, resolveProviderDefaultThinkingLevel, resolveProviderExtraParamsForTransport, resolveProviderFollowupFallbackRoute, resolveProviderModernModelRef, resolveProviderReasoningOutputModeWithPlugin, resolveProviderReplayPolicyWithPlugin, resolveProviderRuntimePlugin, resolveProviderStreamFn, resolveProviderSyntheticAuthWithPlugin, resolveProviderSystemPromptContribution, resolveProviderTextTransforms, resolveProviderThinkingProfile, resolveProviderTransportTurnStateWithPlugin, resolveProviderUsageAuthWithPlugin, resolveProviderUsageSnapshotWithPlugin, resolveProviderWebSocketSessionPolicyWithPlugin, resolveProviderXHighThinking, runProviderDynamicModel, sanitizeProviderReplayHistoryWithPlugin, shouldDeferProviderSyntheticProfileAuthWithPlugin, shouldPreferProviderRuntimeResolvedModel, transformProviderSystemPrompt, validateProviderReplayTurnsWithPlugin, wrapProviderStreamFn };
}
declare function resetExternalAuthFallbackWarningCacheForTest(): void;
declare const __testing: {
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
}): Promise<_$_earendil_works_pi_agent_core0.AgentMessage[] | null | undefined>;
declare function validateProviderReplayTurnsWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderValidateReplayTurnsContext;
}): Promise<_$_earendil_works_pi_agent_core0.AgentMessage[] | null | undefined>;
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
  context: ProviderCreateStreamFnContext;
}): _$_earendil_works_pi_agent_core0.StreamFn | undefined;
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
}): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | null | undefined;
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
}): boolean | undefined;
declare function augmentModelCatalogWithProviderPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderAugmentModelCatalogContext;
}): Promise<ModelCatalogEntry[]>;
//#endregion
export { normalizeProviderResolvedModelWithPlugin as a, provider_runtime_d_exports as c, buildProviderUnknownModelHintWithPlugin as i, runProviderDynamicModel as l, applyProviderResolvedTransportWithPlugin as n, normalizeProviderTransportWithPlugin as o, augmentModelCatalogWithProviderPlugins as r, prepareProviderDynamicModel as s, applyProviderResolvedModelCompatWithPlugins as t, shouldPreferProviderRuntimeResolvedModel as u };