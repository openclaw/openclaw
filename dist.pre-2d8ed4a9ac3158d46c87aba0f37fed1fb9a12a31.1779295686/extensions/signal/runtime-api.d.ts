import { i as OpenClawConfig } from "../../types.openclaw-DPnlcagS.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-CHNX91pr.js";
import { E as resolveChannelMediaMaxBytes } from "../../media-runtime-CYkHgag6.js";
import { g as chunkText } from "../../outbound.types-CaslTlwW.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-remGx4m5.js";
import { C as OpenClawPluginApi } from "../../types-D0OCNFd4.js";
import { l as normalizeE164 } from "../../utils-qPx1BPM5.js";
import { n as ChannelPlugin } from "../../types.public-BlA4mimK.js";
import { n as PluginRuntime } from "../../types-CvAaVTok.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-n-2O0yIV.js";
import { r as buildChannelConfigSchema } from "../../config-schema-BZ1GGqdH.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-DgCYXJ_C.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-CmNo9ew-.js";
import { n as formatPairingApproveHint } from "../../helpers-DhtzxdgZ.js";
import { d as getChatChannelMeta } from "../../core-C8KY8DKx.js";
import { t as formatCliCommand } from "../../command-format-BqtXLLGI.js";
import { t as detectBinary } from "../../detect-binary-C_DX3_nt.js";
import { t as formatDocsLink } from "../../links-3m_d3NMc.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-CgfdTume.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-CT5xAlrM.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-C0D9s3Q-.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-Br6neYyv.js";
import { a as resolveSignalAccount, c as probeSignal, i as resolveDefaultSignalAccountId, n as listEnabledSignalAccounts, o as SignalAccountConfig, r as listSignalAccountIds, t as ResolvedSignalAccount } from "../../accounts-tiIsuKZ9.js";
import { a as sendMessageSignal, f as monitorSignalProvider, p as signalMessageActions, u as resolveSignalReactionLevel } from "../../send-Cj2PZrEu.js";
import { c as installSignalCli, n as normalizeSignalMessagingTarget, t as looksLikeSignalTargetId } from "../../normalize-D_3Ag7Bc.js";
import { i as sendReactionSignal, r as removeReactionSignal } from "../../send-reactions-708YT82u.js";

//#region extensions/signal/src/runtime.d.ts
declare const setSignalRuntime: (next: PluginRuntime) => void, clearSignalRuntime: () => void;
//#endregion
export { type ChannelMessageActionAdapter, type ChannelPlugin, DEFAULT_ACCOUNT_ID, type OpenClawConfig, type OpenClawPluginApi, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type ResolvedSignalAccount, type SignalAccountConfig, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };