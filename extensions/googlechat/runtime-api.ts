// Private runtime barrel for the bundled Google Chat extension.
// Keep this curated to the symbols used by production code under extensions/googlechat/src.

export {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "../../src/agents/tools/common.js";
export {
  createScopedAccountConfigAccessors,
  createScopedChannelConfigBase,
  createScopedDmSecurityResolver,
} from "../../src/plugin-sdk/channel-config-helpers.js";
export {
  buildOpenGroupPolicyConfigureRouteAllowlistWarning,
  collectAllowlistProviderGroupPolicyWarnings,
} from "../../src/plugin-sdk/channel-policy.js";
export { resolveMentionGatingWithBypass } from "../../src/channels/mention-gating.js";
export { formatNormalizedAllowFromEntries } from "../../src/plugin-sdk/allow-from.js";
export { buildComputedAccountStatusSnapshot } from "../../src/plugin-sdk/status-helpers.js";
export {
  createAccountStatusSink,
  runPassiveAccountLifecycle,
} from "../../src/plugin-sdk/channel-lifecycle.js";
export { buildChannelConfigSchema } from "../../src/channels/plugins/config-schema.js";
export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../../src/channels/plugins/config-helpers.js";
export {
  listDirectoryGroupEntriesFromMapKeys,
  listDirectoryUserEntriesFromAllowFrom,
} from "../../src/channels/plugins/directory-config-helpers.js";
export { formatPairingApproveHint } from "../../src/channels/plugins/helpers.js";
export { resolveChannelMediaMaxBytes } from "../../src/channels/plugins/media-limits.js";
export {
  addWildcardAllowFrom,
  mergeAllowFromEntries,
  splitSetupEntries,
  setTopLevelChannelDmPolicyWithAllowFrom,
} from "../../src/channels/plugins/setup-wizard-helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../../src/channels/plugins/pairing-message.js";
export {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  migrateBaseNameToDefaultAccount,
} from "../../src/channels/plugins/setup-helpers.js";
export { createAccountListHelpers } from "../../src/channels/plugins/account-helpers.js";
export type {
  ChannelAccountSnapshot,
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelStatusIssue,
} from "../../src/channels/plugins/types.js";
export type { ChannelPlugin } from "../../src/channels/plugins/types.plugin.js";
export { getChatChannelMeta } from "../../src/channels/registry.js";
export { createReplyPrefixOptions } from "../../src/channels/reply-prefix.js";
export type { OpenClawConfig } from "../../src/config/config.js";
export { isDangerousNameMatchingEnabled } from "../../src/config/dangerous-name-matching.js";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../../src/config/runtime-group-policy.js";
export type {
  DmPolicy,
  GoogleChatAccountConfig,
  GoogleChatConfig,
} from "../../src/config/types.js";
export { isSecretRef } from "../../src/config/types.secrets.js";
export { GoogleChatConfigSchema } from "../../src/config/zod-schema.providers-core.js";
export { fetchWithSsrFGuard } from "../../src/infra/net/fetch-guard.js";
export { missingTargetError } from "../../src/infra/outbound/target-errors.js";
export { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
export type { PluginRuntime } from "../../src/plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../../src/plugins/types.js";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../src/routing/session-key.js";
export { resolveDmGroupAccessWithLists } from "../../src/security/dm-policy-shared.js";
export { formatDocsLink } from "../../src/terminal/links.js";
export type { WizardPrompter } from "../../src/wizard/prompts.js";
export { resolveInboundRouteEnvelopeBuilderWithRuntime } from "../../src/plugin-sdk/inbound-envelope.js";
export { createScopedPairingAccess } from "../../src/plugin-sdk/pairing-access.js";
export { issuePairingChallenge } from "../../src/pairing/pairing-challenge.js";
export {
  evaluateGroupRouteAccessForPolicy,
  resolveSenderScopedGroupPolicy,
} from "../../src/plugin-sdk/group-access.js";
export { extractToolSend } from "../../src/plugin-sdk/tool-send.js";
export { resolveWebhookPath } from "../../src/plugin-sdk/webhook-path.js";
export type { WebhookInFlightLimiter } from "../../src/plugin-sdk/webhook-request-guards.js";
export {
  beginWebhookRequestPipelineOrReject,
  createWebhookInFlightLimiter,
  readJsonWebhookBodyOrReject,
} from "../../src/plugin-sdk/webhook-request-guards.js";
export {
  registerWebhookTargetWithPluginRoute,
  resolveWebhookTargets,
  resolveWebhookTargetWithAuthOrReject,
  withResolvedWebhookRequestPipeline,
} from "../../src/plugin-sdk/webhook-targets.js";
