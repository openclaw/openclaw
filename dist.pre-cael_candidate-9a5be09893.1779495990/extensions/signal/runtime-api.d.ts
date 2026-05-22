import { i as OpenClawConfig } from "../../types.openclaw-GamulG8g.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-Dh6XMgGH.js";
import { E as resolveChannelMediaMaxBytes } from "../../media-runtime-CPvAbfuF.js";
import { g as chunkText } from "../../outbound.types-Cgk5Z_wx.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-C6a4QJNn.js";
import { C as OpenClawPluginApi } from "../../types-DolEO2Jl.js";
import { l as normalizeE164 } from "../../utils-DSrjARXN.js";
import { n as ChannelPlugin } from "../../types.public-0ZbPwK4W.js";
import { n as PluginRuntime } from "../../types-AFN3jLI5.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-Hv18ulJz.js";
import { r as buildChannelConfigSchema } from "../../config-schema-Dx48Ud8L.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-DgllYAT2.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-Cxel7zzf.js";
import { n as formatPairingApproveHint } from "../../helpers--aK0DnVp.js";
import { d as getChatChannelMeta } from "../../core-DtIyxGtF.js";
import { t as formatCliCommand } from "../../command-format-d2gWtZzp.js";
import { t as detectBinary } from "../../detect-binary-DqlFLJ1Y.js";
import { t as formatDocsLink } from "../../links-Dz13kJx9.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-BQMFOBke.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-AZcwFUZz.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-Cvm3ksrt.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-DpDVXTcV.js";
import { a as resolveSignalAccount, c as probeSignal, i as resolveDefaultSignalAccountId, n as listEnabledSignalAccounts, o as SignalAccountConfig, r as listSignalAccountIds, t as ResolvedSignalAccount } from "../../accounts-Dymts-Pd.js";
import { a as sendMessageSignal, f as monitorSignalProvider, p as signalMessageActions, u as resolveSignalReactionLevel } from "../../send-DGCYSzMX.js";
import { c as installSignalCli, n as normalizeSignalMessagingTarget, t as looksLikeSignalTargetId } from "../../normalize-BtYM5FLJ.js";
import { i as sendReactionSignal, r as removeReactionSignal } from "../../send-reactions-BqBNAmjv.js";

//#region extensions/signal/src/runtime.d.ts
declare const setSignalRuntime: (next: PluginRuntime) => void, clearSignalRuntime: () => void;
//#endregion
export { type ChannelMessageActionAdapter, type ChannelPlugin, DEFAULT_ACCOUNT_ID, type OpenClawConfig, type OpenClawPluginApi, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type ResolvedSignalAccount, type SignalAccountConfig, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };