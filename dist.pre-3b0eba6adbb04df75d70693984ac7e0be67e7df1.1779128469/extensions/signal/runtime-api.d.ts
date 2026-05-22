import { i as OpenClawConfig } from "../../types.openclaw-DZQrhn8E.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-Ds9BBXA3.js";
import { E as resolveChannelMediaMaxBytes } from "../../media-runtime-D04dttxa.js";
import { g as chunkText } from "../../outbound.types-DKGVr4LC.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-DiLRQ15F.js";
import { C as OpenClawPluginApi } from "../../types-_HTuWOFH.js";
import { l as normalizeE164 } from "../../utils-CW0tmUjp.js";
import { n as ChannelPlugin } from "../../types.public-BGobpRnR.js";
import { n as PluginRuntime } from "../../types-DIe2gsAQ.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-DefLyVXv.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DrNcI0sQ.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-bN62ZgI1.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-C_UsfPQF.js";
import { n as formatPairingApproveHint } from "../../helpers-0b3jR0Yk.js";
import { d as getChatChannelMeta } from "../../core-CqCwEN3z.js";
import { t as formatCliCommand } from "../../command-format-BFzorQ0C.js";
import { t as detectBinary } from "../../detect-binary-BhBoZHmy.js";
import { t as formatDocsLink } from "../../links-C-iMxrnk.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-w96f2wiG.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-DBDCj8AZ.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-sKHu-JZm.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-C_u5FZmu.js";
import { a as resolveSignalAccount, c as probeSignal, i as resolveDefaultSignalAccountId, n as listEnabledSignalAccounts, o as SignalAccountConfig, r as listSignalAccountIds, t as ResolvedSignalAccount } from "../../accounts-Bsi_XWht.js";
import { a as sendMessageSignal, f as monitorSignalProvider, p as signalMessageActions, u as resolveSignalReactionLevel } from "../../send-D3eTfHAr.js";
import { c as installSignalCli, n as normalizeSignalMessagingTarget, t as looksLikeSignalTargetId } from "../../normalize-CMBnkRE_.js";
import { i as sendReactionSignal, r as removeReactionSignal } from "../../send-reactions-CMeIdVmm.js";

//#region extensions/signal/src/runtime.d.ts
declare const setSignalRuntime: (next: PluginRuntime) => void, clearSignalRuntime: () => void;
//#endregion
export { type ChannelMessageActionAdapter, type ChannelPlugin, DEFAULT_ACCOUNT_ID, type OpenClawConfig, type OpenClawPluginApi, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type ResolvedSignalAccount, type SignalAccountConfig, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };