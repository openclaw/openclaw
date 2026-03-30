// Private runtime barrel for the bundled Signal extension.
// Prefer narrower SDK subpaths plus local extension seams over the legacy signal barrel.

export { SignalConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
export type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
export { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";

import type { OpenClawConfig as RuntimeOpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
export type { RuntimeOpenClawConfig as OpenClawConfig };
export {
	resolveAllowlistProviderRuntimeGroupPolicy,
	resolveDefaultGroupPolicy,
} from "openclaw/plugin-sdk/config-runtime";
export type {
	ChannelPlugin,
	OpenClawPluginApi,
	PluginRuntime,
} from "openclaw/plugin-sdk/core";
export {
	applyAccountNameToChannelSection,
	buildChannelConfigSchema,
	DEFAULT_ACCOUNT_ID,
	deleteAccountFromConfigSection,
	emptyPluginConfigSchema,
	formatPairingApproveHint,
	getChatChannelMeta,
	migrateBaseNameToDefaultAccount,
	normalizeAccountId,
	setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk/core";
export { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/media-runtime";
export { chunkText } from "openclaw/plugin-sdk/reply-runtime";
export {
	detectBinary,
	formatCliCommand,
	formatDocsLink,
	installSignalCli,
} from "openclaw/plugin-sdk/setup-tools";
export {
	buildBaseAccountStatusSnapshot,
	buildBaseChannelStatusSummary,
	collectStatusIssuesFromLastError,
	createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
export { normalizeE164 } from "openclaw/plugin-sdk/text-runtime";
export type { ResolvedSignalAccount } from "./accounts.js";
export {
	listEnabledSignalAccounts,
	listSignalAccountIds,
	resolveDefaultSignalAccountId,
	resolveSignalAccount,
} from "./accounts.js";
export { signalMessageActions } from "./message-actions.js";
export { monitorSignalProvider } from "./monitor.js";
export {
	looksLikeSignalTargetId,
	normalizeSignalMessagingTarget,
} from "./normalize.js";
export { probeSignal } from "./probe.js";
export { resolveSignalReactionLevel } from "./reaction-level.js";
export { sendMessageSignal } from "./send.js";
export { removeReactionSignal, sendReactionSignal } from "./send-reactions.js";
export type SignalAccountConfig = Omit<
	Exclude<NonNullable<RuntimeOpenClawConfig["channels"]>["signal"], undefined>,
	"accounts"
>;
