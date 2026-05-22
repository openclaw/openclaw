import { i as OpenClawConfig } from "./types.openclaw-BMMD0Ykw.js";
import { l as ModelProviderConfig } from "./types.models-BPif7RZm.js";
import { r as AnyAgentTool } from "./common-MKouOaZh.js";
import { n as FailoverReason } from "./types-CFriAGil.js";
import { t as ModelCatalogEntry } from "./model-catalog.types-PYGpirNi.js";
import { c as OAuthCredential, i as AuthProfileCredential } from "./types-Ce68c77g.js";
import { $n as ProviderResolveSyntheticAuthContext, $t as ProviderNormalizeResolvedModelContext, Cn as ProviderResolveDynamicModelContext, Dn as ProviderResolveUsageAuthContext, Dt as ProviderBuildMissingAuthMessageContext, En as ProviderResolveTransportTurnStateContext, Fn as ProviderTransportTurnState, Gn as ProviderDefaultThinkingPolicyContext, Gt as ProviderFetchUsageSnapshotContext, In as ProviderValidateReplayTurnsContext, It as ProviderCreateEmbeddingProviderContext, Jn as ProviderRuntimeModel, Kn as ProviderThinkingPolicyContext, Ln as ProviderWebSocketSessionPolicy, Lt as ProviderCreateStreamFnContext, Mn as ProviderSystemPromptContributionContext, Nn as ProviderToolSchemaDiagnostic, On as ProviderResolveWebSocketSessionPolicyContext, Ot as ProviderBuildUnknownModelHintContext, Pn as ProviderTransformSystemPromptContext, Qn as ProviderResolveExternalOAuthProfilesContext, Qt as ProviderNormalizeModelIdContext, Rt as ProviderDeferSyntheticProfileAuthContext, Wt as ProviderFailoverErrorContext, Yn as ProviderExternalAuthProfile, Yt as ProviderModernModelPolicyContext, Zn as ProviderResolveExternalAuthProfilesContext, _n as ProviderReplayPolicyContext, br as PluginTextTransforms, en as ProviderNormalizeToolSchemasContext, er as ProviderSyntheticAuthResult, fn as ProviderPrepareRuntimeAuthContext, gn as ProviderReplayPolicy, hn as ProviderReasoningOutputModeContext, jn as ProviderSanitizeReplayHistoryContext, jt as ProviderCacheTtlEligibilityContext, kn as ProviderResolvedUsageAuth, ln as ProviderPreferRuntimeResolvedModelContext, mn as ProviderReasoningOutputMode, ni as ProviderSystemPromptContribution, nr as ProviderNormalizeConfigContext, pn as ProviderPreparedRuntimeAuth, qn as ProviderThinkingProfile, rr as ProviderResolveConfigApiKeyContext, st as PluginEmbeddingProvider, tn as ProviderNormalizeTransportContext, tr as ProviderApplyConfigDefaultsContext, un as ProviderPrepareDynamicModelContext, xt as ProviderAuthDoctorHintContext, yt as ProviderAugmentModelCatalogContext } from "./types-Dd0yIOXW2.js";
import { t as ProviderUsageSnapshot } from "./provider-usage.types-CVpYiqTL.js";
import { a as resolveProviderFollowupFallbackRoute, i as resolveProviderExtraParamsForTransport, n as prepareProviderExtraParams, o as resolveProviderRuntimePlugin, r as resolveProviderAuthProfileId, s as wrapProviderStreamFn, t as ProviderRuntimePluginHandle } from "./pi-embedded-helpers-DLt_yVlj.js";
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
  allowRuntimePluginLoad?: boolean;
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