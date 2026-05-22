import { i as OpenClawConfig } from "../../types.openclaw-C58U02FA.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-1Yw8kMCr.js";
import { E as resolveChannelMediaMaxBytes } from "../../media-runtime-DSOWLZWU.js";
import { g as chunkText } from "../../outbound.types-Bo4urJG2.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-zIW2Gjsy.js";
import { C as OpenClawPluginApi } from "../../types-UTp4ves_.js";
import { l as normalizeE164 } from "../../utils-ByGTa1-u.js";
import { n as ChannelPlugin } from "../../types.public-JfHpZqwR.js";
import { n as PluginRuntime } from "../../types-taiLI91p.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-4tRCVAzE.js";
import { r as buildChannelConfigSchema } from "../../config-schema-BU12utEU.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-DJfRvdXv.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-C1cx9Yzt.js";
import { n as formatPairingApproveHint } from "../../helpers-ClTNBK-7.js";
import { d as getChatChannelMeta } from "../../core-CO-51Zdi.js";
import { t as formatCliCommand } from "../../command-format-CEKvj2ZV.js";
import { t as detectBinary } from "../../detect-binary-Ap-3Rqtx.js";
import { t as formatDocsLink } from "../../links-BYemsnpr.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-C1eIb4OD.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-CmF-3zPi.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-CBg1LFP_.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-CZFt473y.js";
import { a as resolveSignalAccount, c as probeSignal, i as resolveDefaultSignalAccountId, n as listEnabledSignalAccounts, o as SignalAccountConfig, r as listSignalAccountIds, t as ResolvedSignalAccount } from "../../accounts-CW7UtlAZ.js";
import { a as sendMessageSignal, f as monitorSignalProvider, p as signalMessageActions, u as resolveSignalReactionLevel } from "../../send-CJTkatIK.js";
import { c as installSignalCli, n as normalizeSignalMessagingTarget, t as looksLikeSignalTargetId } from "../../normalize-C83J14lp.js";
import { i as sendReactionSignal, r as removeReactionSignal } from "../../send-reactions-HePHo_6s.js";

//#region extensions/signal/src/runtime.d.ts
declare const setSignalRuntime: (next: PluginRuntime) => void, clearSignalRuntime: () => void;
//#endregion
export { type ChannelMessageActionAdapter, type ChannelPlugin, DEFAULT_ACCOUNT_ID, type OpenClawConfig, type OpenClawPluginApi, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type ResolvedSignalAccount, type SignalAccountConfig, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };