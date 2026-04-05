// Private runtime barrel for the bundled IRC extension.
// Keep this barrel thin and generic-only.

export type {
  BaseProbeResult,
  ChannelPlugin,
  MullusiConfig,
  PluginRuntime,
} from "mullusi/plugin-sdk/core";
export type { RuntimeEnv } from "mullusi/plugin-sdk/runtime";
export type {
  BlockStreamingCoalesceConfig,
  DmConfig,
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
  MarkdownConfig,
} from "mullusi/plugin-sdk/config-runtime";
export type { OutboundReplyPayload } from "mullusi/plugin-sdk/reply-payload";
export {
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  getChatChannelMeta,
} from "mullusi/plugin-sdk/core";
export {
  PAIRING_APPROVED_MESSAGE,
  buildBaseChannelStatusSummary,
} from "mullusi/plugin-sdk/channel-status";
export { createChannelPairingController } from "mullusi/plugin-sdk/channel-pairing";
export { createAccountStatusSink } from "mullusi/plugin-sdk/channel-lifecycle";
export {
  readStoreAllowFromForDmPolicy,
  resolveEffectiveAllowFromLists,
} from "mullusi/plugin-sdk/channel-policy";
export { resolveControlCommandGate } from "mullusi/plugin-sdk/command-auth";
export { dispatchInboundReplyWithBase } from "mullusi/plugin-sdk/inbound-reply-dispatch";
export { chunkTextForOutbound } from "mullusi/plugin-sdk/text-chunking";
export {
  deliverFormattedTextWithAttachments,
  formatTextWithAttachmentLinks,
  resolveOutboundMediaUrls,
} from "mullusi/plugin-sdk/reply-payload";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
  isDangerousNameMatchingEnabled,
} from "mullusi/plugin-sdk/config-runtime";
export { logInboundDrop } from "mullusi/plugin-sdk/channel-inbound";
