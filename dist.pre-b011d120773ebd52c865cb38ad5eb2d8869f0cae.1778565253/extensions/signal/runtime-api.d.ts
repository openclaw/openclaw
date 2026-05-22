import { i as OpenClawConfig } from "../../types.openclaw-BdZr8Ncl.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-FZhPryJd.js";
import { h as chunkText } from "../../outbound.types-DgglYInj.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-D5GEzFhB.js";
import { v as OpenClawPluginApi } from "../../types-CyE3PKKi.js";
import { l as normalizeE164 } from "../../utils-qPx1BPM5.js";
import { n as ChannelPlugin } from "../../types.public-CH2hYFDc.js";
import { n as PluginRuntime } from "../../types-4PahHl43.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-BAIDbXwT.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DoRYUMiG.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-B6Efih-0.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-C44ysi1u.js";
import { n as formatPairingApproveHint } from "../../helpers-DTgm3jsn.js";
import { d as getChatChannelMeta } from "../../core-XYbn8ZT8.js";
import { t as formatDocsLink } from "../../links-B1XFmrxw.js";
import { t as formatCliCommand } from "../../command-format-BdKSlZgt.js";
import { E as resolveChannelMediaMaxBytes } from "../../media-runtime-CWmyuAqF.js";
import { t as detectBinary } from "../../detect-binary-dfXg6dTu.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-B3gNb0Lm.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-HwLZ4IGS.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-DfxJPCFm.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-DLOpLkJB.js";
import { a as resolveSignalAccount, c as probeSignal, i as resolveDefaultSignalAccountId, n as listEnabledSignalAccounts, o as SignalAccountConfig, r as listSignalAccountIds, t as ResolvedSignalAccount } from "../../accounts-CV4Z8tlx.js";
import { a as sendMessageSignal, f as monitorSignalProvider, p as signalMessageActions, u as resolveSignalReactionLevel } from "../../send-CxH3UphN.js";
import { c as installSignalCli, n as normalizeSignalMessagingTarget, t as looksLikeSignalTargetId } from "../../normalize-CVWIn6f5.js";
import { i as sendReactionSignal, r as removeReactionSignal } from "../../send-reactions-BaWFPeEN.js";

//#region extensions/signal/src/runtime.d.ts
declare const setSignalRuntime: (next: PluginRuntime) => void, clearSignalRuntime: () => void;
//#endregion
export { type ChannelMessageActionAdapter, type ChannelPlugin, DEFAULT_ACCOUNT_ID, type OpenClawConfig, type OpenClawPluginApi, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type ResolvedSignalAccount, type SignalAccountConfig, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };