// Private runtime barrel for the bundled Zalo extension.
// Keep this barrel thin and aligned with the local extension surface.

export * from "./api.js";
export type { ReplyPayload } from "mullusi/plugin-sdk/reply-runtime";
export type { MullusiConfig, GroupPolicy } from "mullusi/plugin-sdk/config-runtime";
export type { MarkdownTableMode } from "mullusi/plugin-sdk/config-runtime";
export type { BaseTokenResolution } from "mullusi/plugin-sdk/channel-contract";
export type {
  BaseProbeResult,
  ChannelAccountSnapshot,
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelStatusIssue,
} from "mullusi/plugin-sdk/channel-contract";
export type { SecretInput } from "mullusi/plugin-sdk/secret-input";
export type { SenderGroupAccessDecision } from "mullusi/plugin-sdk/group-access";
export type { ChannelPlugin, PluginRuntime, WizardPrompter } from "mullusi/plugin-sdk/core";
export type { RuntimeEnv } from "mullusi/plugin-sdk/runtime";
export type { OutboundReplyPayload } from "mullusi/plugin-sdk/reply-payload";
export {
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  createDedupeCache,
  formatPairingApproveHint,
  jsonResult,
  normalizeAccountId,
  readStringParam,
  resolveClientIp,
} from "mullusi/plugin-sdk/core";
export {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  buildSingleChannelSecretPromptState,
  mergeAllowFromEntries,
  migrateBaseNameToDefaultAccount,
  promptSingleChannelSecretInput,
  runSingleChannelSecretStep,
  setTopLevelChannelDmPolicyWithAllowFrom,
} from "mullusi/plugin-sdk/setup";
export {
  buildSecretInputSchema,
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "mullusi/plugin-sdk/secret-input";
export {
  buildTokenChannelStatusSummary,
  PAIRING_APPROVED_MESSAGE,
} from "mullusi/plugin-sdk/channel-status";
export { buildBaseAccountStatusSnapshot } from "mullusi/plugin-sdk/status-helpers";
export { chunkTextForOutbound } from "mullusi/plugin-sdk/text-chunking";
export {
  formatAllowFromLowercase,
  isNormalizedSenderAllowed,
} from "mullusi/plugin-sdk/allow-from";
export { addWildcardAllowFrom } from "mullusi/plugin-sdk/setup";
export { evaluateSenderGroupAccess } from "mullusi/plugin-sdk/group-access";
export { resolveOpenProviderRuntimeGroupPolicy } from "mullusi/plugin-sdk/config-runtime";
export {
  warnMissingProviderGroupPolicyFallbackOnce,
  resolveDefaultGroupPolicy,
} from "mullusi/plugin-sdk/config-runtime";
export { createChannelPairingController } from "mullusi/plugin-sdk/channel-pairing";
export { createChannelReplyPipeline } from "mullusi/plugin-sdk/channel-reply-pipeline";
export { logTypingFailure } from "mullusi/plugin-sdk/channel-feedback";
export {
  deliverTextOrMediaReply,
  isNumericTargetId,
  sendPayloadWithChunkedTextAndMedia,
} from "mullusi/plugin-sdk/reply-payload";
export {
  resolveDirectDmAuthorizationOutcome,
  resolveSenderCommandAuthorizationWithRuntime,
} from "mullusi/plugin-sdk/command-auth";
export { resolveInboundRouteEnvelopeBuilderWithRuntime } from "mullusi/plugin-sdk/inbound-envelope";
export { waitForAbortSignal } from "mullusi/plugin-sdk/runtime";
export {
  applyBasicWebhookRequestGuards,
  createFixedWindowRateLimiter,
  createWebhookAnomalyTracker,
  readJsonWebhookBodyOrReject,
  registerWebhookTarget,
  registerWebhookTargetWithPluginRoute,
  resolveWebhookPath,
  resolveWebhookTargetWithAuthOrRejectSync,
  WEBHOOK_ANOMALY_COUNTER_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
  withResolvedWebhookRequestPipeline,
} from "mullusi/plugin-sdk/webhook-ingress";
export type {
  RegisterWebhookPluginRouteOptions,
  RegisterWebhookTargetOptions,
} from "mullusi/plugin-sdk/webhook-ingress";
