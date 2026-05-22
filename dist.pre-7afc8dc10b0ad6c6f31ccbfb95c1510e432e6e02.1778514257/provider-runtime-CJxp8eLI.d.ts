import { i as OpenClawConfig } from "./types.openclaw-C9E_zZnO.js";
import { l as ModelProviderConfig } from "./types.models-gg_vEQfc.js";
import { r as AnyAgentTool } from "./common-BTwhyOZ1.js";
import { n as FailoverReason } from "./types-D4xoVXc6.js";
import { t as ModelCatalogEntry } from "./model-catalog.types-BN5LqwSr.js";
import { n as AuthProfileCredential, o as OAuthCredential } from "./types-DNLAqYp7.js";
import { Bn as ProviderExternalAuthProfile, Bt as ProviderModernModelPolicyContext, Cn as ProviderSystemPromptContributionContext, Dn as ProviderValidateReplayTurnsContext, Dt as ProviderCreateEmbeddingProviderContext, En as ProviderTransportTurnState, Ft as ProviderFailoverErrorContext, Gn as ProviderSyntheticAuthResult, Gt as ProviderNormalizeToolSchemasContext, Hn as ProviderResolveExternalAuthProfilesContext, In as ProviderDefaultThinkingPolicyContext, It as ProviderFetchUsageSnapshotContext, Jn as ProviderResolveConfigApiKeyContext, Kn as ProviderApplyConfigDefaultsContext, Kt as ProviderNormalizeTransportContext, Ln as ProviderThinkingPolicyContext, On as ProviderWebSocketSessionPolicy, Ot as ProviderCreateStreamFnContext, Q as PluginEmbeddingProvider, Rn as ProviderThinkingProfile, Sn as ProviderSanitizeReplayHistoryContext, St as ProviderCacheTtlEligibilityContext, Tn as ProviderTransformSystemPromptContext, Un as ProviderResolveExternalOAuthProfilesContext, Ut as ProviderNormalizeModelIdContext, Wn as ProviderResolveSyntheticAuthContext, Wt as ProviderNormalizeResolvedModelContext, _n as ProviderResolveTransportTurnStateContext, an as ProviderReasoningOutputMode, bn as ProviderResolvedUsageAuth, cn as ProviderReplayPolicyContext, dr as PluginTextTransforms, en as ProviderPreferRuntimeResolvedModelContext, ft as ProviderAuthDoctorHintContext, in as ProviderPreparedRuntimeAuth, kt as ProviderDeferSyntheticProfileAuthContext, mn as ProviderResolveDynamicModelContext, on as ProviderReasoningOutputModeContext, qn as ProviderNormalizeConfigContext, qr as ProviderSystemPromptContribution, rn as ProviderPrepareRuntimeAuthContext, sn as ProviderReplayPolicy, tn as ProviderPrepareDynamicModelContext, ut as ProviderAugmentModelCatalogContext, vn as ProviderResolveUsageAuthContext, vt as ProviderBuildMissingAuthMessageContext, wn as ProviderToolSchemaDiagnostic, yn as ProviderResolveWebSocketSessionPolicyContext, yt as ProviderBuildUnknownModelHintContext, zn as ProviderRuntimeModel } from "./types-BOTb5nyG.js";
import { t as ProviderUsageSnapshot } from "./provider-usage.types-ClBHrP_c.js";
import { a as resolveProviderFollowupFallbackRoute, i as resolveProviderExtraParamsForTransport, n as prepareProviderExtraParams, o as resolveProviderRuntimePlugin, r as resolveProviderAuthProfileId, s as wrapProviderStreamFn, t as ProviderRuntimePluginHandle } from "./provider-hook-runtime-BEqWx6kU.js";
import * as _$_mariozechner_pi_agent_core0 from "@mariozechner/pi-agent-core";

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
}): Promise<_$_mariozechner_pi_agent_core0.AgentMessage[] | null | undefined>;
declare function validateProviderReplayTurnsWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderValidateReplayTurnsContext;
}): Promise<_$_mariozechner_pi_agent_core0.AgentMessage[] | null | undefined>;
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
}): _$_mariozechner_pi_agent_core0.StreamFn | undefined;
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