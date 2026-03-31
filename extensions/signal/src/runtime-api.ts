// Private runtime barrel for the bundled Signal extension.
// Prefer narrower SDK subpaths plus local extension seams over the legacy signal barrel.

export type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
export { SignalConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
export { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
import type { OpenClawConfig as RuntimeOpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
export type { RuntimeOpenClawConfig as OpenClawConfig };
export type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk/core";
export type { ChannelPlugin } from "openclaw/plugin-sdk/core";
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
export { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/media-runtime";
export { formatCliCommand, formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
export { chunkText } from "openclaw/plugin-sdk/reply-runtime";
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
export { normalizeE164 } from "openclaw/plugin-sdk/text-runtime";
export { looksLikeSignalTargetId, normalizeSignalMessagingTarget } from "./normalize.js";
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
export type SignalAccountConfig = Omit<
  Exclude<NonNullable<RuntimeOpenClawConfig["channels"]>["signal"], undefined>,
  "accounts"
>;
