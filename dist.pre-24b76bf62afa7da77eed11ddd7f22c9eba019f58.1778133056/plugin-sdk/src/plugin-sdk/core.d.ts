import type { ResolvedConfiguredAcpBinding } from "../acp/persistent-bindings.types.js";
import type { ChatChannelId } from "../channels/ids.js";
import type { ChannelOutboundAdapter, ChannelPairingAdapter, ChannelSecurityAdapter } from "../channels/plugins/types.adapters.js";
import type { ChannelConfigSchema } from "../channels/plugins/types.config.js";
import type { ChannelMessagingAdapter, ChannelOutboundSessionRoute, ChannelPollResult, ChannelThreadingAdapter } from "../channels/plugins/types.core.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelMeta } from "../channels/plugins/types.public.js";
import type { ReplyToMode } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OutboundDeliveryResult } from "../infra/outbound/deliver.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { OpenClawPluginApi } from "../plugins/types.js";
export type { AgentHarness, AnyAgentTool, MediaUnderstandingProviderPlugin, OpenClawPluginApi, OpenClawPluginCommandDefinition, OpenClawPluginConfigSchema, OpenClawPluginDefinition, OpenClawPluginService, OpenClawPluginServiceContext, PluginCommandContext, PluginCommandResult, PluginAgentEventSubscriptionRegistration, PluginAgentTurnPrepareEvent, PluginAgentTurnPrepareResult, PluginControlUiDescriptor, PluginHeartbeatPromptContributionEvent, PluginHeartbeatPromptContributionResult, PluginJsonValue, PluginNextTurnInjection, PluginNextTurnInjectionEnqueueResult, PluginNextTurnInjectionRecord, PluginRunContextGetParams, PluginRunContextPatch, PluginRuntimeLifecycleRegistration, PluginSessionSchedulerJobHandle, PluginSessionSchedulerJobRegistration, PluginSessionExtensionRegistration, PluginSessionExtensionProjection, PluginToolMetadataRegistration, PluginTrustedToolPolicyRegistration, PluginLogger, ProviderAuthContext, ProviderAuthDoctorHintContext, ProviderAuthMethod, ProviderAuthMethodNonInteractiveContext, ProviderAuthResult, ProviderAugmentModelCatalogContext, ProviderBuildMissingAuthMessageContext, ProviderBuildUnknownModelHintContext, ProviderBuiltInModelSuppressionContext, ProviderBuiltInModelSuppressionResult, ProviderCacheTtlEligibilityContext, ProviderCatalogContext, ProviderCatalogResult, ProviderDefaultThinkingPolicyContext, ProviderDiscoveryContext, ProviderFetchUsageSnapshotContext, ProviderModernModelPolicyContext, ProviderNormalizeResolvedModelContext, ProviderNormalizeToolSchemasContext, ProviderPrepareDynamicModelContext, ProviderPrepareExtraParamsContext, ProviderPrepareRuntimeAuthContext, ProviderPreparedRuntimeAuth, ProviderReasoningOutputMode, ProviderReasoningOutputModeContext, ProviderReplayPolicy, ProviderReplayPolicyContext, ProviderReplaySessionEntry, ProviderReplaySessionState, ProviderResolveDynamicModelContext, ProviderResolveTransportTurnStateContext, ProviderResolveWebSocketSessionPolicyContext, ProviderResolvedUsageAuth, RealtimeTranscriptionProviderPlugin, ProviderSanitizeReplayHistoryContext, ProviderTransportTurnState, ProviderToolSchemaDiagnostic, ProviderResolveUsageAuthContext, ProviderThinkingProfile, ProviderThinkingPolicyContext, ProviderValidateReplayTurnsContext, ProviderWebSocketSessionPolicy, ProviderWrapStreamFnContext, SpeechProviderPlugin, } from "./plugin-entry.js";
export type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
export type { OpenClawPluginToolContext, OpenClawPluginToolFactory } from "../plugins/types.js";
export type { MemoryPluginCapability, MemoryPluginPublicArtifact, MemoryPluginPublicArtifactsProvider, } from "../plugins/memory-state.js";
export type { PluginHookReplyDispatchContext, PluginHookReplyDispatchEvent, PluginHookReplyDispatchResult, } from "../plugins/types.js";
export type { OpenClawConfig } from "../config/config.js";
export type { OutboundIdentity } from "../infra/outbound/identity.js";
export type { HistoryEntry } from "../auto-reply/reply/history.js";
export type { ReplyPayload } from "./reply-payload.js";
export type { AllowlistMatch } from "../channels/allowlist-match.js";
export type { BaseProbeResult, ChannelAccountSnapshot, ChannelGroupContext, ChannelMessageActionName, ChannelMeta, ChannelSetupInput, } from "../channels/plugins/types.public.js";
export type { ChatType } from "../channels/chat-type.js";
export type { NormalizedLocation } from "../channels/location.js";
export type { ChannelDirectoryEntry } from "../channels/plugins/types.core.js";
export type { ChannelOutboundAdapter } from "../channels/plugins/types.adapters.js";
export type { PollInput } from "../polls.js";
export { isSecretRef } from "../config/types.secrets.js";
export type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
export type { ChannelOutboundSessionRoute, ChannelMessagingAdapter, } from "../channels/plugins/types.core.js";
export type { ProviderUsageSnapshot, UsageProviderId, UsageWindow, } from "../infra/provider-usage.types.js";
export type { ChannelMessageActionContext } from "../channels/plugins/types.public.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export type { ChannelConfigUiHint } from "../channels/plugins/types.config.js";
export type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { definePluginEntry } from "./plugin-entry.js";
export { buildJsonPluginConfigSchema, buildPluginConfigSchema, emptyPluginConfigSchema, } from "../plugins/config-schema.js";
export { KeyedAsyncQueue, enqueueKeyedTask } from "./keyed-async-queue.js";
export { createDedupeCache, resolveGlobalDedupeCache } from "../infra/dedupe.js";
export { generateSecureToken, generateSecureUuid } from "../infra/secure-random.js";
export { buildMemorySystemPromptAddition, delegateCompactionToRuntime, } from "../context-engine/delegate.js";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
export { buildChannelConfigSchema, buildJsonChannelConfigSchema, emptyChannelConfigSchema, } from "../channels/plugins/config-schema.js";
export { applyAccountNameToChannelSection, migrateBaseNameToDefaultAccount, } from "../channels/plugins/setup-helpers.js";
export { clearAccountEntryFields, deleteAccountFromConfigSection, setAccountEnabledInConfigSection, } from "../channels/plugins/config-helpers.js";
export { formatPairingApproveHint, parseOptionalDelimitedEntries, } from "../channels/plugins/helpers.js";
export { channelTargetSchema, channelTargetsSchema, optionalStringEnum, stringEnum, } from "../agents/schema/typebox.js";
export { DEFAULT_SECRET_FILE_MAX_BYTES, loadSecretFileSync, readSecretFileSync, tryReadSecretFileSync, } from "../infra/secret-file.js";
export type { SecretFileReadOptions, SecretFileReadResult } from "../infra/secret-file.js";
export { resolveGatewayBindUrl } from "../shared/gateway-bind-url.js";
export type { GatewayBindUrlResult } from "../shared/gateway-bind-url.js";
export { resolveGatewayPort } from "../config/paths.js";
export { createSubsystemLogger } from "../logging/subsystem.js";
export { normalizeAtHashSlug, normalizeHyphenSlug } from "../shared/string-normalization.js";
export { createActionGate } from "../agents/tools/common.js";
export { jsonResult, readNumberParam, readReactionParams, readStringArrayParam, readStringParam, } from "../agents/tools/common.js";
export { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
export { isTrustedProxyAddress, resolveClientIp } from "../gateway/net.js";
export { formatZonedTimestamp } from "../infra/format-time/format-datetime.js";
export { resolveConfiguredAcpBindingRecord } from "../acp/persistent-bindings.resolve.js";
export declare function ensureConfiguredAcpBindingReady(params: {
    cfg: OpenClawConfig;
    configuredBinding: ResolvedConfiguredAcpBinding | null;
}): Promise<{
    ok: true;
} | {
    ok: false;
    error: string;
}>;
export { resolveTailnetHostWithRunner } from "../shared/tailscale-status.js";
export type { TailscaleStatusCommandResult, TailscaleStatusCommandRunner, } from "../shared/tailscale-status.js";
export { buildAgentSessionKey, type RoutePeer, type RoutePeerKind, } from "../routing/resolve-route.js";
export { resolveThreadSessionKeys } from "../routing/session-key.js";
export type ChannelOutboundSessionRouteParams = Parameters<NonNullable<ChannelMessagingAdapter["resolveOutboundSessionRoute"]>>[0];
export declare function getChatChannelMeta(id: ChatChannelId): ChannelMeta;
/** Remove one of the known provider prefixes from a free-form target string. */
export declare function stripChannelTargetPrefix(raw: string, ...providers: string[]): string;
/** Remove generic target-kind prefixes such as `user:` or `group:`. */
export declare function stripTargetKindPrefix(raw: string): string;
/**
 * Build the canonical outbound session route payload returned by channel
 * message adapters.
 */
export declare function buildChannelOutboundSessionRoute(params: {
    cfg: OpenClawConfig;
    agentId: string;
    channel: string;
    accountId?: string | null;
    peer: {
        kind: "direct" | "group" | "channel";
        id: string;
    };
    chatType: "direct" | "group" | "channel";
    from: string;
    to: string;
    threadId?: string | number;
}): ChannelOutboundSessionRoute;
export type ThreadAwareOutboundSessionRouteThreadSource = "replyToId" | "threadId" | "currentSession";
export type ThreadAwareOutboundSessionRouteRecoveryContext = {
    route: ChannelOutboundSessionRoute;
    currentBaseSessionKey: string;
    currentThreadId: string;
};
export declare function recoverCurrentThreadSessionId(params: {
    route: ChannelOutboundSessionRoute;
    currentSessionKey?: string | null;
    canRecover?: (context: ThreadAwareOutboundSessionRouteRecoveryContext) => boolean;
}): string | undefined;
export declare function buildThreadAwareOutboundSessionRoute(params: {
    route: ChannelOutboundSessionRoute;
    replyToId?: string | number | null;
    threadId?: string | number | null;
    currentSessionKey?: string | null;
    precedence?: readonly ThreadAwareOutboundSessionRouteThreadSource[];
    useSuffix?: boolean;
    parentSessionKey?: string;
    normalizeThreadId?: (threadId: string) => string;
    canRecoverCurrentThread?: (context: ThreadAwareOutboundSessionRouteRecoveryContext) => boolean;
}): ChannelOutboundSessionRoute;
/** Options for a channel plugin entry that should register a channel capability. */
type ChannelEntryConfigSchema<TPlugin> = TPlugin extends ChannelPlugin<unknown> ? NonNullable<TPlugin["configSchema"]> : ChannelConfigSchema;
type DefineChannelPluginEntryOptions<TPlugin = ChannelPlugin> = {
    id: string;
    name: string;
    description: string;
    plugin: TPlugin;
    configSchema?: ChannelEntryConfigSchema<TPlugin> | (() => ChannelEntryConfigSchema<TPlugin>);
    setRuntime?: (runtime: PluginRuntime) => void;
    registerCliMetadata?: (api: OpenClawPluginApi) => void;
    registerFull?: (api: OpenClawPluginApi) => void;
};
type DefinedChannelPluginEntry<TPlugin> = {
    id: string;
    name: string;
    description: string;
    configSchema: ChannelEntryConfigSchema<TPlugin>;
    register: (api: OpenClawPluginApi) => void;
    channelPlugin: TPlugin;
    setChannelRuntime?: (runtime: PluginRuntime) => void;
};
type CreateChannelPluginBaseOptions<TResolvedAccount> = {
    id: ChannelPlugin<TResolvedAccount>["id"];
    meta?: Partial<NonNullable<ChannelPlugin<TResolvedAccount>["meta"]>>;
    setupWizard?: NonNullable<ChannelPlugin<TResolvedAccount>["setupWizard"]>;
    capabilities?: ChannelPlugin<TResolvedAccount>["capabilities"];
    commands?: ChannelPlugin<TResolvedAccount>["commands"];
    doctor?: ChannelPlugin<TResolvedAccount>["doctor"];
    agentPrompt?: ChannelPlugin<TResolvedAccount>["agentPrompt"];
    streaming?: ChannelPlugin<TResolvedAccount>["streaming"];
    reload?: ChannelPlugin<TResolvedAccount>["reload"];
    gatewayMethods?: ChannelPlugin<TResolvedAccount>["gatewayMethods"];
    configSchema?: ChannelPlugin<TResolvedAccount>["configSchema"];
    config?: ChannelPlugin<TResolvedAccount>["config"];
    security?: ChannelPlugin<TResolvedAccount>["security"];
    setup: NonNullable<ChannelPlugin<TResolvedAccount>["setup"]>;
    groups?: ChannelPlugin<TResolvedAccount>["groups"];
};
type CreatedChannelPluginBase<TResolvedAccount> = Pick<ChannelPlugin<TResolvedAccount>, "id" | "meta" | "setup"> & Partial<Pick<ChannelPlugin<TResolvedAccount>, "setupWizard" | "capabilities" | "commands" | "doctor" | "agentPrompt" | "streaming" | "reload" | "gatewayMethods" | "configSchema" | "config" | "security" | "groups">>;
/**
 * Canonical entry helper for channel plugins.
 *
 * This wraps `definePluginEntry(...)`, registers the channel capability, and
 * optionally exposes extra full-runtime registration such as tools or gateway
 * handlers that only make sense outside setup-only registration modes.
 */
export declare function defineChannelPluginEntry<TPlugin>({ id, name, description, plugin, configSchema, setRuntime, registerCliMetadata, registerFull }: DefineChannelPluginEntryOptions<TPlugin>): DefinedChannelPluginEntry<TPlugin>;
/**
 * Minimal setup-entry helper for channels that ship a separate `setup-entry.ts`.
 *
 * The setup entry only needs to export `{ plugin }`, but using this helper
 * keeps the shape explicit in examples and generated typings.
 */
export declare function defineSetupPluginEntry<TPlugin>(plugin: TPlugin): {
    plugin: TPlugin;
};
type ChatChannelPluginBase<TResolvedAccount, Probe, Audit> = Omit<ChannelPlugin<TResolvedAccount, Probe, Audit>, "security" | "pairing" | "threading" | "outbound"> & Partial<Pick<ChannelPlugin<TResolvedAccount, Probe, Audit>, "security" | "pairing" | "threading" | "outbound">>;
type ChatChannelSecurityOptions<TResolvedAccount extends {
    accountId?: string | null;
}> = {
    dm: {
        channelKey: string;
        resolvePolicy: (account: TResolvedAccount) => string | null | undefined;
        resolveAllowFrom: (account: TResolvedAccount) => Array<string | number> | null | undefined;
        resolveFallbackAccountId?: (account: TResolvedAccount) => string | null | undefined;
        defaultPolicy?: string;
        allowFromPathSuffix?: string;
        policyPathSuffix?: string;
        approveChannelId?: string;
        approveHint?: string;
        normalizeEntry?: (raw: string) => string;
        inheritSharedDefaultsFromDefaultAccount?: boolean;
    };
    collectWarnings?: ChannelSecurityAdapter<TResolvedAccount>["collectWarnings"];
    collectAuditFindings?: ChannelSecurityAdapter<TResolvedAccount>["collectAuditFindings"];
};
type ChatChannelPairingOptions = {
    text: {
        idLabel: string;
        message: string;
        normalizeAllowEntry?: ChannelPairingAdapter["normalizeAllowEntry"];
        notify: (params: Parameters<NonNullable<ChannelPairingAdapter["notifyApproval"]>>[0] & {
            message: string;
        }) => Promise<void> | void;
    };
};
type ChatChannelThreadingReplyModeOptions<TResolvedAccount> = {
    topLevelReplyToMode: string;
} | {
    scopedAccountReplyToMode: {
        resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => TResolvedAccount;
        resolveReplyToMode: (account: TResolvedAccount, chatType?: string | null) => ReplyToMode | null | undefined;
        fallback?: ReplyToMode;
    };
} | {
    resolveReplyToMode: NonNullable<ChannelThreadingAdapter["resolveReplyToMode"]>;
};
type ChatChannelThreadingOptions<TResolvedAccount> = ChatChannelThreadingReplyModeOptions<TResolvedAccount> & Omit<ChannelThreadingAdapter, "resolveReplyToMode">;
type ChatChannelAttachedOutboundOptions = {
    base: Omit<ChannelOutboundAdapter, "sendText" | "sendMedia" | "sendPoll">;
    attachedResults: {
        channel: string;
        sendText?: (ctx: Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0]) => MaybePromise<Omit<OutboundDeliveryResult, "channel">>;
        sendMedia?: (ctx: Parameters<NonNullable<ChannelOutboundAdapter["sendMedia"]>>[0]) => MaybePromise<Omit<OutboundDeliveryResult, "channel">>;
        sendPoll?: (ctx: Parameters<NonNullable<ChannelOutboundAdapter["sendPoll"]>>[0]) => MaybePromise<Omit<ChannelPollResult, "channel">>;
    };
};
type MaybePromise<T> = T | Promise<T>;
export declare function createChatChannelPlugin<TResolvedAccount extends {
    accountId?: string | null;
}, Probe = unknown, Audit = unknown>(params: {
    base: ChatChannelPluginBase<TResolvedAccount, Probe, Audit>;
    security?: ChannelSecurityAdapter<TResolvedAccount> | ChatChannelSecurityOptions<TResolvedAccount>;
    pairing?: ChannelPairingAdapter | ChatChannelPairingOptions;
    threading?: ChannelThreadingAdapter | ChatChannelThreadingOptions<TResolvedAccount>;
    outbound?: ChannelOutboundAdapter | ChatChannelAttachedOutboundOptions;
}): ChannelPlugin<TResolvedAccount, Probe, Audit>;
export declare function createChannelPluginBase<TResolvedAccount>(params: CreateChannelPluginBaseOptions<TResolvedAccount>): CreatedChannelPluginBase<TResolvedAccount>;
