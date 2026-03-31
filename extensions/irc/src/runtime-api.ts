// Private runtime barrel for the bundled IRC extension.
// Keep this barrel thin and aligned with the local extension surface.

export {
  buildBaseChannelStatusSummary,
  createAccountStatusSink,
  chunkTextForOutbound,
  createChannelPairingController,
  DEFAULT_ACCOUNT_ID,
  deliverFormattedTextWithAttachments,
  dispatchInboundReplyWithBase,
  getChatChannelMeta,
  GROUP_POLICY_BLOCKED_LABEL,
  isDangerousNameMatchingEnabled,
  logInboundDrop,
  PAIRING_APPROVED_MESSAGE,
  readStoreAllowFromForDmPolicy,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveControlCommandGate,
  resolveDefaultGroupPolicy,
  resolveEffectiveAllowFromLists,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/irc";
export type {
  BaseProbeResult,
  BlockStreamingCoalesceConfig,
  ChannelPlugin,
  DmConfig,
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
  MarkdownConfig,
  OpenClawConfig,
  OutboundReplyPayload,
  PluginRuntime,
  RuntimeEnv,
} from "openclaw/plugin-sdk/irc";
