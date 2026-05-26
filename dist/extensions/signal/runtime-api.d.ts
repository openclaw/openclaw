import { i as OpenClawConfig } from "../../types.openclaw-DIZy8jcb.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-DfCsc96R.js";
import { h as chunkText } from "../../outbound.types-COmT4EQP.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-1gFCH89g.js";
import { v as OpenClawPluginApi } from "../../types-lCXG2pW_.js";
import { l as normalizeE164 } from "../../utils-DyHdMcsc.js";
import { n as ChannelPlugin } from "../../types.public-BfuQlAVf.js";
import { n as PluginRuntime } from "../../types-DtDIgr2k.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-9gP0nNrZ.js";
import { r as buildChannelConfigSchema } from "../../config-schema-CjXvdXRL.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-DQEyVf_O.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-hJA4bEpu.js";
import { n as formatPairingApproveHint } from "../../helpers-eyAi3Cla.js";
import { d as getChatChannelMeta } from "../../core-BW4coGrc.js";
import { t as formatCliCommand } from "../../command-format-BwsLHvU1.js";
import { E as resolveChannelMediaMaxBytes } from "../../media-runtime-N7LXvAKY.js";
import { t as detectBinary } from "../../detect-binary-CRNhE5H3.js";
import { t as formatDocsLink } from "../../links-BWDUqax-.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-C9MxrWZd.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-DoVbZEu3.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-zpr3QJIn.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-YRDypMy8.js";
import { a as resolveSignalAccount, c as probeSignal, i as resolveDefaultSignalAccountId, n as listEnabledSignalAccounts, o as SignalAccountConfig, r as listSignalAccountIds, t as ResolvedSignalAccount } from "../../accounts-BqKPHZLa.js";
import { a as sendMessageSignal, f as monitorSignalProvider, p as signalMessageActions, u as resolveSignalReactionLevel } from "../../send-CipCU2tN.js";
import { c as installSignalCli, n as normalizeSignalMessagingTarget, t as looksLikeSignalTargetId } from "../../normalize-Bfd2y0j-.js";
import { i as sendReactionSignal, r as removeReactionSignal } from "../../send-reactions-C8y_Te1K.js";

//#region extensions/signal/src/runtime.d.ts
declare const setSignalRuntime: (next: PluginRuntime) => void, clearSignalRuntime: () => void;
//#endregion
export { type ChannelMessageActionAdapter, type ChannelPlugin, DEFAULT_ACCOUNT_ID, type OpenClawConfig, type OpenClawPluginApi, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type ResolvedSignalAccount, type SignalAccountConfig, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };