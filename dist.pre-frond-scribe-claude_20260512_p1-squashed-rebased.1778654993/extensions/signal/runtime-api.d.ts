import { i as OpenClawConfig } from "../../types.openclaw-BdSNxnBz.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-BWIRLVzl.js";
import { h as chunkText } from "../../outbound.types-DsiI6f93.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-BDQOD1ST.js";
import { v as OpenClawPluginApi } from "../../types-ItMBrbf4.js";
import { l as normalizeE164 } from "../../utils-DqKz1rhL.js";
import { n as ChannelPlugin } from "../../types.public-D-nwYThg.js";
import { n as PluginRuntime } from "../../types-Czv_rpgT.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-CjzfD09B.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DvPswMZV.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-DfRmBmkW.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-e0OcdXit.js";
import { n as formatPairingApproveHint } from "../../helpers-B34oaxp4.js";
import { d as getChatChannelMeta } from "../../core-dPpcEVVc.js";
import { t as formatDocsLink } from "../../links-BL9VXA_h.js";
import { t as formatCliCommand } from "../../command-format-DukPOALB.js";
import { E as resolveChannelMediaMaxBytes } from "../../media-runtime-Bwp-c7Qu.js";
import { t as detectBinary } from "../../detect-binary-CR62SfZr.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-Z6wyRouH.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-D2cbzMRA.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-CFXzNVGU.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-D4UCyrhD.js";
import { a as resolveSignalAccount, c as probeSignal, i as resolveDefaultSignalAccountId, n as listEnabledSignalAccounts, o as SignalAccountConfig, r as listSignalAccountIds, t as ResolvedSignalAccount } from "../../accounts-Btq4dj1_.js";
import { a as sendMessageSignal, f as monitorSignalProvider, p as signalMessageActions, u as resolveSignalReactionLevel } from "../../send-jjSjJHPX.js";
import { c as installSignalCli, n as normalizeSignalMessagingTarget, t as looksLikeSignalTargetId } from "../../normalize-B-zxS8yx.js";
import { i as sendReactionSignal, r as removeReactionSignal } from "../../send-reactions-DZXq_XH8.js";

//#region extensions/signal/src/runtime.d.ts
declare const setSignalRuntime: (next: PluginRuntime) => void, clearSignalRuntime: () => void;
//#endregion
export { type ChannelMessageActionAdapter, type ChannelPlugin, DEFAULT_ACCOUNT_ID, type OpenClawConfig, type OpenClawPluginApi, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type ResolvedSignalAccount, type SignalAccountConfig, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };