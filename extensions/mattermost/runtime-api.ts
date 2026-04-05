// Private runtime barrel for the bundled Mattermost extension.
// Keep this barrel thin and generic-only.

export type {
  BaseProbeResult,
  ChannelAccountSnapshot,
  ChannelDirectoryEntry,
  ChannelGroupContext,
  ChannelMessageActionName,
  ChannelPlugin,
  ChatType,
  HistoryEntry,
  MullusiConfig,
  MullusiPluginApi,
  PluginRuntime,
} from "mullusi/plugin-sdk/core";
export type { RuntimeEnv } from "mullusi/plugin-sdk/runtime";
export type { ReplyPayload } from "mullusi/plugin-sdk/reply-runtime";
export type { ModelsProviderData } from "mullusi/plugin-sdk/command-auth";
export type {
  BlockStreamingCoalesceConfig,
  DmPolicy,
  GroupPolicy,
} from "mullusi/plugin-sdk/config-runtime";
export {
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  createDedupeCache,
  parseStrictPositiveInteger,
  resolveClientIp,
  isTrustedProxyAddress,
} from "mullusi/plugin-sdk/core";
export { buildComputedAccountStatusSnapshot } from "mullusi/plugin-sdk/channel-status";
export { createAccountStatusSink } from "mullusi/plugin-sdk/channel-lifecycle";
export { buildAgentMediaPayload } from "mullusi/plugin-sdk/agent-media-payload";
export {
  buildModelsProviderData,
  listSkillCommandsForAgents,
  resolveControlCommandGate,
  resolveStoredModelOverride,
} from "mullusi/plugin-sdk/command-auth";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  isDangerousNameMatchingEnabled,
  loadSessionStore,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveStorePath,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "mullusi/plugin-sdk/config-runtime";
export { formatInboundFromLabel } from "mullusi/plugin-sdk/channel-inbound";
export { logInboundDrop } from "mullusi/plugin-sdk/channel-inbound";
export { createChannelPairingController } from "mullusi/plugin-sdk/channel-pairing";
export {
  DM_GROUP_ACCESS_REASON,
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
  resolveEffectiveAllowFromLists,
} from "mullusi/plugin-sdk/channel-policy";
export { evaluateSenderGroupAccessForPolicy } from "mullusi/plugin-sdk/group-access";
export { createChannelReplyPipeline } from "mullusi/plugin-sdk/channel-reply-pipeline";
export { logTypingFailure } from "mullusi/plugin-sdk/channel-feedback";
export { loadOutboundMediaFromUrl } from "mullusi/plugin-sdk/outbound-media";
export { rawDataToString } from "mullusi/plugin-sdk/browser-support";
export { chunkTextForOutbound } from "mullusi/plugin-sdk/text-chunking";
export {
  DEFAULT_GROUP_HISTORY_LIMIT,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled,
} from "mullusi/plugin-sdk/reply-history";
export { normalizeAccountId, resolveThreadSessionKeys } from "mullusi/plugin-sdk/routing";
export { resolveAllowlistMatchSimple } from "mullusi/plugin-sdk/allow-from";
export { registerPluginHttpRoute } from "mullusi/plugin-sdk/webhook-targets";
export {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
} from "mullusi/plugin-sdk/webhook-ingress";
export {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  migrateBaseNameToDefaultAccount,
} from "mullusi/plugin-sdk/setup";
export {
  getAgentScopedMediaLocalRoots,
  resolveChannelMediaMaxBytes,
} from "mullusi/plugin-sdk/media-runtime";
export { normalizeProviderId } from "mullusi/plugin-sdk/provider-model-shared";
