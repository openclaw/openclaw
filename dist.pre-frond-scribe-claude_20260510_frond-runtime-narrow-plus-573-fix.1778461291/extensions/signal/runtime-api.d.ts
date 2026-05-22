import { i as OpenClawConfig } from "../../types.openclaw-CoVv5VQR.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-Ds9BBXA3.js";
import { h as chunkText } from "../../outbound.types-DfHbN8bI.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-CQScvK0N.js";
import { g as OpenClawPluginApi } from "../../types-BYigPDoy.js";
import { l as normalizeE164 } from "../../utils-BJ3pI6_E.js";
import { n as ChannelPlugin } from "../../types.public-BMrZTIWg.js";
import { n as PluginRuntime } from "../../types-DVhGJHIy.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-DgDxLjcs.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DyWSTJ5E.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-ukpCWXr-.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-LRAjEvpf.js";
import { n as formatPairingApproveHint } from "../../helpers-Dha4-Jey.js";
import { d as getChatChannelMeta } from "../../core-dElfdZxg.js";
import { t as formatDocsLink } from "../../links-CHEr6bub.js";
import { t as formatCliCommand } from "../../command-format-CDoDJY3x.js";
import { E as resolveChannelMediaMaxBytes } from "../../media-runtime-C9QwyK0J.js";
import { t as detectBinary } from "../../detect-binary-B7XkyViG.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-STYjuANm.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-CVVv_KUh.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-BunjMIEf.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-BVNvbSOL.js";
import { a as resolveSignalAccount, c as probeSignal, i as resolveDefaultSignalAccountId, n as listEnabledSignalAccounts, o as SignalAccountConfig, r as listSignalAccountIds, t as ResolvedSignalAccount } from "../../accounts-Bnx3dBqw.js";
import { a as sendMessageSignal, f as monitorSignalProvider, p as signalMessageActions, u as resolveSignalReactionLevel } from "../../send-BHzvKIFW.js";
import { c as installSignalCli, n as normalizeSignalMessagingTarget, t as looksLikeSignalTargetId } from "../../normalize-BXt-XTGC.js";
import { i as sendReactionSignal, r as removeReactionSignal } from "../../send-reactions-Csnp85uU.js";

//#region extensions/signal/src/runtime.d.ts
declare const setSignalRuntime: (next: PluginRuntime) => void, clearSignalRuntime: () => void;
//#endregion
export { type ChannelMessageActionAdapter, type ChannelPlugin, DEFAULT_ACCOUNT_ID, type OpenClawConfig, type OpenClawPluginApi, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type ResolvedSignalAccount, type SignalAccountConfig, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };