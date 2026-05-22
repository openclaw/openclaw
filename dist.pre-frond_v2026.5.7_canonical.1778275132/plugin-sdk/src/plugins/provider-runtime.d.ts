import type { AuthProfileCredential, OAuthCredential } from "../agents/auth-profiles/types.js";
import type { ProviderSystemPromptContribution } from "../agents/system-prompt-contribution.js";
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareProviderExtraParams, resolveProviderAuthProfileId, resolveProviderExtraParamsForTransport, resolveProviderFollowupFallbackRoute, resolveProviderRuntimePlugin, wrapProviderStreamFn } from "./provider-hook-runtime.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import type { ProviderThinkingProfile } from "./provider-thinking.types.js";
import type { ProviderAuthDoctorHintContext, ProviderAugmentModelCatalogContext, ProviderExternalAuthProfile, ProviderBuildMissingAuthMessageContext, ProviderBuildUnknownModelHintContext, ProviderCacheTtlEligibilityContext, ProviderCreateEmbeddingProviderContext, ProviderDeferSyntheticProfileAuthContext, ProviderResolveSyntheticAuthContext, ProviderCreateStreamFnContext, ProviderDefaultThinkingPolicyContext, ProviderFetchUsageSnapshotContext, ProviderFailoverErrorContext, ProviderNormalizeToolSchemasContext, ProviderNormalizeConfigContext, ProviderNormalizeModelIdContext, ProviderReasoningOutputMode, ProviderReasoningOutputModeContext, ProviderReplayPolicy, ProviderReplayPolicyContext, ProviderNormalizeResolvedModelContext, ProviderNormalizeTransportContext, ProviderModernModelPolicyContext, ProviderPrepareDynamicModelContext, ProviderPreferRuntimeResolvedModelContext, ProviderResolveExternalAuthProfilesContext, ProviderResolveExternalOAuthProfilesContext, ProviderPrepareRuntimeAuthContext, ProviderApplyConfigDefaultsContext, ProviderResolveConfigApiKeyContext, ProviderSanitizeReplayHistoryContext, ProviderResolveUsageAuthContext, ProviderResolveDynamicModelContext, ProviderResolveTransportTurnStateContext, ProviderResolveWebSocketSessionPolicyContext, ProviderSystemPromptContributionContext, ProviderTransformSystemPromptContext, ProviderThinkingPolicyContext, ProviderTransportTurnState, ProviderValidateReplayTurnsContext, ProviderWebSocketSessionPolicy, PluginTextTransforms } from "./types.js";
declare function resetExternalAuthFallbackWarningCacheForTest(): void;
export { prepareProviderExtraParams, resolveProviderAuthProfileId, resolveProviderExtraParamsForTransport, resolveProviderFollowupFallbackRoute, resolveProviderRuntimePlugin, wrapProviderStreamFn, };
export declare const __testing: {
    readonly resetExternalAuthFallbackWarningCacheForTest: typeof resetExternalAuthFallbackWarningCacheForTest;
};
export declare function runProviderDynamicModel(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderResolveDynamicModelContext;
}): ProviderRuntimeModel | undefined;
export declare function resolveProviderSystemPromptContribution(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderSystemPromptContributionContext;
}): ProviderSystemPromptContribution | undefined;
export declare function transformProviderSystemPrompt(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderTransformSystemPromptContext;
}): string;
export declare function resolveProviderTextTransforms(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): PluginTextTransforms | undefined;
export declare function prepareProviderDynamicModel(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderPrepareDynamicModelContext;
}): Promise<void>;
export declare function shouldPreferProviderRuntimeResolvedModel(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderPreferRuntimeResolvedModelContext;
}): boolean;
export declare function normalizeProviderResolvedModelWithPlugin(params: {
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
export declare function applyProviderResolvedModelCompatWithPlugins(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderNormalizeResolvedModelContext;
}): ProviderRuntimeModel | undefined;
export declare function applyProviderResolvedTransportWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderNormalizeResolvedModelContext;
}): ProviderRuntimeModel | undefined;
export declare function normalizeProviderModelIdWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderNormalizeModelIdContext;
}): string | undefined;
export declare function normalizeProviderTransportWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderNormalizeTransportContext;
}): {
    api?: string | null;
    baseUrl?: string;
} | undefined;
export declare function normalizeProviderConfigWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderNormalizeConfigContext;
    allowRuntimePluginLoad?: boolean;
}): ModelProviderConfig | undefined;
export declare function applyProviderNativeStreamingUsageCompatWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderNormalizeConfigContext;
    allowRuntimePluginLoad?: boolean;
}): ModelProviderConfig | undefined;
export declare function resolveProviderConfigApiKeyWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderResolveConfigApiKeyContext;
    allowRuntimePluginLoad?: boolean;
}): string | undefined;
export declare function resolveProviderReplayPolicyWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderReplayPolicyContext;
}): ProviderReplayPolicy | undefined;
export declare function sanitizeProviderReplayHistoryWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderSanitizeReplayHistoryContext;
}): Promise<import("@mariozechner/pi-agent-core").AgentMessage[] | null | undefined>;
export declare function validateProviderReplayTurnsWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderValidateReplayTurnsContext;
}): Promise<import("@mariozechner/pi-agent-core").AgentMessage[] | null | undefined>;
export declare function normalizeProviderToolSchemasWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderNormalizeToolSchemasContext;
}): import("./types.js").AnyAgentTool[] | undefined;
export declare function inspectProviderToolSchemasWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderNormalizeToolSchemasContext;
}): import("./types.js").ProviderToolSchemaDiagnostic[] | undefined;
export declare function resolveProviderReasoningOutputModeWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderReasoningOutputModeContext;
}): ProviderReasoningOutputMode | undefined;
export declare function resolveProviderStreamFn(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderCreateStreamFnContext;
}): import("@mariozechner/pi-agent-core").StreamFn | undefined;
export declare function resolveProviderTransportTurnStateWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderResolveTransportTurnStateContext;
}): ProviderTransportTurnState | undefined;
export declare function resolveProviderWebSocketSessionPolicyWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderResolveWebSocketSessionPolicyContext;
}): ProviderWebSocketSessionPolicy | undefined;
export declare function createProviderEmbeddingProvider(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderCreateEmbeddingProviderContext;
}): Promise<import("./types.js").PluginEmbeddingProvider | null | undefined>;
export declare function prepareProviderRuntimeAuth(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderPrepareRuntimeAuthContext;
}): Promise<import("./types.js").ProviderPreparedRuntimeAuth | null | undefined>;
export declare function resolveProviderUsageAuthWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderResolveUsageAuthContext;
}): Promise<import("./types.js").ProviderResolvedUsageAuth | null | undefined>;
export declare function resolveProviderUsageSnapshotWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderFetchUsageSnapshotContext;
}): Promise<import("openclaw/plugin-sdk/core").ProviderUsageSnapshot | null | undefined>;
export declare function matchesProviderContextOverflowWithPlugin(params: {
    provider?: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderFailoverErrorContext;
}): boolean;
export declare function classifyProviderFailoverReasonWithPlugin(params: {
    provider?: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderFailoverErrorContext;
}): import("../agents/pi-embedded-helpers.ts").FailoverReason | undefined;
export declare function formatProviderAuthProfileApiKeyWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: AuthProfileCredential;
}): string | undefined;
export declare function refreshProviderOAuthCredentialWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: OAuthCredential;
}): Promise<OAuthCredential | undefined>;
export declare function buildProviderAuthDoctorHintWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderAuthDoctorHintContext;
}): Promise<string | null | undefined>;
export declare function resolveProviderCacheTtlEligibility(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderCacheTtlEligibilityContext;
}): boolean | undefined;
export declare function resolveProviderBinaryThinking(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderThinkingPolicyContext;
}): boolean | undefined;
export declare function resolveProviderXHighThinking(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderThinkingPolicyContext;
}): boolean | undefined;
export declare function resolveProviderThinkingProfile(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderDefaultThinkingPolicyContext;
}): ProviderThinkingProfile | null | undefined;
export declare function resolveProviderDefaultThinkingLevel(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderDefaultThinkingPolicyContext;
}): "adaptive" | "high" | "low" | "medium" | "minimal" | "off" | "xhigh" | null | undefined;
export declare function applyProviderConfigDefaultsWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderApplyConfigDefaultsContext;
}): OpenClawConfig | undefined;
export declare function resolveProviderModernModelRef(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderModernModelPolicyContext;
}): boolean | undefined;
export declare function buildProviderMissingAuthMessageWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderBuildMissingAuthMessageContext;
}): string | undefined;
export declare function buildProviderUnknownModelHintWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderBuildUnknownModelHintContext;
}): string | undefined;
export declare function resolveProviderSyntheticAuthWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderResolveSyntheticAuthContext;
}): import("./provider-external-auth.types.ts").ProviderSyntheticAuthResult | null | undefined;
export declare function resolveExternalAuthProfilesWithPlugins(params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderResolveExternalAuthProfilesContext;
}): ProviderExternalAuthProfile[];
export declare function resolveExternalOAuthProfilesWithPlugins(params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderResolveExternalOAuthProfilesContext;
}): ProviderExternalAuthProfile[];
export declare function shouldDeferProviderSyntheticProfileAuthWithPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderDeferSyntheticProfileAuthContext;
}): boolean | undefined;
export declare function augmentModelCatalogWithProviderPlugins(params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    context: ProviderAugmentModelCatalogContext;
}): Promise<import("openclaw/plugin-sdk/agent-runtime").ModelCatalogEntry[]>;
