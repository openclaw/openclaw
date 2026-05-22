import { i as OpenClawConfig } from "../../types.openclaw-C9E_zZnO.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-COvVZOrq.js";
import { h as chunkText } from "../../outbound.types-IRn7e6X5.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-gexONR-2.js";
import { g as OpenClawPluginApi } from "../../types-BOTb5nyG.js";
import { l as normalizeE164 } from "../../utils-D1CyDeib.js";
import { n as ChannelPlugin } from "../../types.public-D_xOTs5v.js";
import { n as PluginRuntime } from "../../types-C2b0JJwH.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-BrD06iyI.js";
import { r as buildChannelConfigSchema } from "../../config-schema-O6SnT1Ui.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-BiMKUKgZ.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-DPUhGRgw.js";
import { n as formatPairingApproveHint } from "../../helpers-CY6gt87C.js";
import { d as getChatChannelMeta } from "../../core-53CbbVNe.js";
import { t as formatDocsLink } from "../../links-Dn-V-Ta-.js";
import { t as formatCliCommand } from "../../command-format-cdRIcxsQ.js";
import { E as resolveChannelMediaMaxBytes } from "../../media-runtime-DEhWRvDO.js";
import { t as detectBinary } from "../../detect-binary-Ap-3Rqtx.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-CFR3xeVt.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-BaPtUGas.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-BGT0Arbg.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-Bxt7lLvD.js";
import { a as resolveSignalAccount, c as probeSignal, i as resolveDefaultSignalAccountId, n as listEnabledSignalAccounts, o as SignalAccountConfig, r as listSignalAccountIds, t as ResolvedSignalAccount } from "../../accounts-Bhctkgs6.js";
import { a as sendMessageSignal, f as monitorSignalProvider, p as signalMessageActions, u as resolveSignalReactionLevel } from "../../send-UFAysE-l.js";
import { c as installSignalCli, n as normalizeSignalMessagingTarget, t as looksLikeSignalTargetId } from "../../normalize-DeKas4hB.js";
import { i as sendReactionSignal, r as removeReactionSignal } from "../../send-reactions-CIgy9aUa.js";

//#region extensions/signal/src/runtime.d.ts
declare const setSignalRuntime: (next: PluginRuntime) => void, clearSignalRuntime: () => void;
//#endregion
export { type ChannelMessageActionAdapter, type ChannelPlugin, DEFAULT_ACCOUNT_ID, type OpenClawConfig, type OpenClawPluginApi, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type ResolvedSignalAccount, type SignalAccountConfig, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };