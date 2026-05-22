import { i as OpenClawConfig } from "../../types.openclaw-CQzDxdpQ.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-jXSHRHDW.js";
import { E as resolveChannelMediaMaxBytes } from "../../media-runtime-6_aqXYT2.js";
import { g as chunkText } from "../../outbound.types-_qtghrWY.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-DrB_kWzl.js";
import { C as OpenClawPluginApi } from "../../types-Bb8qdnX4.js";
import { l as normalizeE164 } from "../../utils-D4sGGnmQ.js";
import { n as ChannelPlugin } from "../../types.public-C5MFEvPW.js";
import { n as PluginRuntime } from "../../types-CXGnubLv.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-qPpVWTHO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-D14tWtON.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-B6E5yIe0.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-BHmEWJy3.js";
import { n as formatPairingApproveHint } from "../../helpers-re-h1spq.js";
import { d as getChatChannelMeta } from "../../core-DN78eEbj.js";
import { t as formatCliCommand } from "../../command-format-D5QvN9Qa.js";
import { t as detectBinary } from "../../detect-binary-ChRBgiNO.js";
import { t as formatDocsLink } from "../../links-CqRokiRU.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-VYDXV5_b.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-CeBGjAic.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-DgSZFPBU.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-BsyYnCvF.js";
import { a as resolveSignalAccount, c as probeSignal, i as resolveDefaultSignalAccountId, n as listEnabledSignalAccounts, o as SignalAccountConfig, r as listSignalAccountIds, t as ResolvedSignalAccount } from "../../accounts-D6gOTwzF.js";
import { a as sendMessageSignal, f as monitorSignalProvider, p as signalMessageActions, u as resolveSignalReactionLevel } from "../../send-C2y-hGXe.js";
import { c as installSignalCli, n as normalizeSignalMessagingTarget, t as looksLikeSignalTargetId } from "../../normalize-CH4JULE2.js";
import { i as sendReactionSignal, r as removeReactionSignal } from "../../send-reactions-7N1iA11o.js";

//#region extensions/signal/src/runtime.d.ts
declare const setSignalRuntime: (next: PluginRuntime) => void, clearSignalRuntime: () => void;
//#endregion
export { type ChannelMessageActionAdapter, type ChannelPlugin, DEFAULT_ACCOUNT_ID, type OpenClawConfig, type OpenClawPluginApi, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type ResolvedSignalAccount, type SignalAccountConfig, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };