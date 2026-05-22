/**
 * @deprecated Legacy compat surface for external plugins that still depend on
 * older broad plugin-sdk imports. Use focused openclaw/plugin-sdk subpaths
 * instead.
 */
import { createChannelReplyPipeline as createChannelReplyPipelineCompat, createReplyPrefixContext as createReplyPrefixContextCompat, createReplyPrefixOptions as createReplyPrefixOptionsCompat, createTypingCallbacks as createTypingCallbacksCompat, resolveChannelSourceReplyDeliveryMode as resolveChannelSourceReplyDeliveryModeCompat, type ChannelReplyPipeline as ChannelReplyPipelineCompat, type CreateTypingCallbacksParams as CreateTypingCallbacksParamsCompat, type ReplyPrefixContext as ReplyPrefixContextCompat, type ReplyPrefixContextBundle as ReplyPrefixContextBundleCompat, type ReplyPrefixOptions as ReplyPrefixOptionsCompat, type SourceReplyDeliveryMode as SourceReplyDeliveryModeCompat, type TypingCallbacks as TypingCallbacksCompat } from "./channel-reply-pipeline.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { MemoryPluginCapability, MemoryPluginPublicArtifact, MemoryPluginPublicArtifactsProvider, } from "../plugins/memory-state.js";
export { resolveControlCommandGate } from "../channels/command-gating.js";
export { buildMemorySystemPromptAddition, delegateCompactionToRuntime, } from "../context-engine/delegate.js";
export { registerContextEngine } from "../context-engine/registry.js";
export type { DiagnosticEventPayload } from "../infra/diagnostic-events.js";
export { onDiagnosticEvent } from "../infra/diagnostic-events.js";
export { optionalStringEnum, stringEnum } from "../agents/schema/typebox.js";
export { applyAuthProfileConfig, buildApiKeyCredential, upsertApiKeyProfile, writeOAuthCredentials, type ApiKeyStorageOptions, type WriteOAuthCredentialsOptions, } from "../plugins/provider-auth-helpers.js";
export { createAccountStatusSink } from "./channel-lifecycle.core.js";
export { createPluginRuntimeStore } from "./runtime-store.js";
export { KeyedAsyncQueue } from "./keyed-async-queue.js";
export { normalizeAccountId } from "./account-id.js";
export { resolvePreferredOpenClawTmpDir } from "./temp-path.js";
export { createHybridChannelConfigAdapter, createHybridChannelConfigBase, createScopedAccountConfigAccessors, createScopedChannelConfigAdapter, createScopedChannelConfigBase, createScopedDmSecurityResolver, createTopLevelChannelConfigAdapter, createTopLevelChannelConfigBase, mapAllowFromEntries, } from "./channel-config-helpers.js";
export { formatAllowFromLowercase, formatNormalizedAllowFromEntries } from "./allow-from.js";
export * from "./channel-config-schema.js";
export * from "./channel-policy.js";
export { collectOpenGroupPolicyConfiguredRouteWarnings } from "./channel-policy.js";
export * from "./reply-history.js";
export * from "./directory-runtime.js";
export { mapAllowlistResolutionInputs } from "./allow-from.js";
/** @deprecated Use `openclaw/plugin-sdk/channel-reply-pipeline`. */
export declare const createChannelReplyPipeline: typeof createChannelReplyPipelineCompat;
/** @deprecated Use `openclaw/plugin-sdk/channel-reply-pipeline`. */
export declare const createReplyPrefixContext: typeof createReplyPrefixContextCompat;
/** @deprecated Use `openclaw/plugin-sdk/channel-reply-pipeline`. */
export declare const createReplyPrefixOptions: typeof createReplyPrefixOptionsCompat;
/** @deprecated Use `openclaw/plugin-sdk/channel-reply-pipeline`. */
export declare const createTypingCallbacks: typeof createTypingCallbacksCompat;
/** @deprecated Use `openclaw/plugin-sdk/channel-reply-pipeline`. */
export declare const resolveChannelSourceReplyDeliveryMode: typeof resolveChannelSourceReplyDeliveryModeCompat;
/** @deprecated Use `openclaw/plugin-sdk/channel-reply-pipeline`. */
export type ChannelReplyPipeline = ChannelReplyPipelineCompat;
/** @deprecated Use `openclaw/plugin-sdk/channel-reply-pipeline`. */
export type CreateTypingCallbacksParams = CreateTypingCallbacksParamsCompat;
/** @deprecated Use `openclaw/plugin-sdk/channel-reply-pipeline`. */
export type ReplyPrefixContext = ReplyPrefixContextCompat;
/** @deprecated Use `openclaw/plugin-sdk/channel-reply-pipeline`. */
export type ReplyPrefixContextBundle = ReplyPrefixContextBundleCompat;
/** @deprecated Use `openclaw/plugin-sdk/channel-reply-pipeline`. */
export type ReplyPrefixOptions = ReplyPrefixOptionsCompat;
/** @deprecated Use `openclaw/plugin-sdk/channel-reply-pipeline`. */
export type SourceReplyDeliveryMode = SourceReplyDeliveryModeCompat;
/** @deprecated Use `openclaw/plugin-sdk/channel-reply-pipeline`. */
export type TypingCallbacks = TypingCallbacksCompat;
export { resolveBlueBubblesGroupRequireMention, resolveBlueBubblesGroupToolPolicy, } from "./bluebubbles-policy.js";
export { collectBlueBubblesStatusIssues } from "./bluebubbles.js";
