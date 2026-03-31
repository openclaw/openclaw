// Private runtime barrel for the bundled Signal extension.
// Prefer narrower SDK subpaths plus local extension seams over the legacy signal barrel.

export type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
export type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
export type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk/core";
export {
  DEFAULT_ACCOUNT_ID,
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  deleteAccountFromConfigSection,
  emptyPluginConfigSchema,
  formatPairingApproveHint,
  getChatChannelMeta,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk/core";
export { formatCliCommand, formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
export { chunkText } from "openclaw/plugin-sdk/reply-runtime";
export {
  PAIRING_APPROVED_MESSAGE,
  SignalConfigSchema,
  looksLikeSignalTargetId,
  normalizeE164,
  normalizeSignalMessagingTarget,
  resolveChannelMediaMaxBytes,
} from "openclaw/plugin-sdk/signal-core";
export type { ChannelPlugin, SignalAccountConfig } from "openclaw/plugin-sdk/signal-core";
export { detectBinary, installSignalCli } from "openclaw/plugin-sdk/setup-tools";
export {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
} from "openclaw/plugin-sdk/config-runtime";
export {
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
export {
  listEnabledSignalAccounts,
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "./accounts.js";
export { monitorSignalProvider } from "./monitor.js";
export { probeSignal } from "./probe.js";
export { resolveSignalReactionLevel } from "./reaction-level.js";
export { removeReactionSignal, sendReactionSignal } from "./send-reactions.js";
export { sendMessageSignal } from "./send.js";
export { signalMessageActions } from "./message-actions.js";
export type { ResolvedSignalAccount } from "./accounts.js";
