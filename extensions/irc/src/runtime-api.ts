// Private runtime barrel for the bundled IRC extension.
// Keep this barrel thin and generic-only.

export type {
  BaseProbeResult,
  ChannelPlugin,
  OpenClawConfig,
  PluginRuntime,
} from "openclaw/plugin-sdk/core";
export type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
export type {
  BlockStreamingCoalesceConfig,
  DmConfig,
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
  MarkdownConfig,
} from "openclaw/plugin-sdk/config-runtime";
export type { OutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
export {
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  getChatChannelMeta,
} from "openclaw/plugin-sdk/core";
export {
  PAIRING_APPROVED_MESSAGE,
  buildBaseChannelStatusSummary,
} from "openclaw/plugin-sdk/channel-status";
export { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
export { createAccountStatusSink } from "openclaw/plugin-sdk/compat";
export {
  readStoreAllowFromForDmPolicy,
  resolveEffectiveAllowFromLists,
} from "openclaw/plugin-sdk/channel-policy";
export { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth";
export { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
export { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
export {
  deliverFormattedTextWithAttachments,
  formatTextWithAttachmentLinks,
  resolveOutboundMediaUrls,
} from "openclaw/plugin-sdk/reply-payload";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
  isDangerousNameMatchingEnabled,
} from "openclaw/plugin-sdk/config-runtime";
export { logInboundDrop } from "openclaw/plugin-sdk/channel-inbound";
