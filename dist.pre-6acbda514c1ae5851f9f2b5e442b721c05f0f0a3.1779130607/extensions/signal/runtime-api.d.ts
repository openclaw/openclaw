import { i as OpenClawConfig } from "../../types.openclaw-BYfkTL_f.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-Ds9BBXA3.js";
import { E as resolveChannelMediaMaxBytes } from "../../media-runtime-C_h6wIm7.js";
import { g as chunkText } from "../../outbound.types-DuRB2RNl.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-DMG-czl3.js";
import { C as OpenClawPluginApi } from "../../types-CkHYPqDj.js";
import { l as normalizeE164 } from "../../utils-CW0tmUjp.js";
import { n as ChannelPlugin } from "../../types.public-CwqPONY3.js";
import { n as PluginRuntime } from "../../types-PzLD5nJ3.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-CglZbbBl.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DrNcI0sQ.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-CmWj157a.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-BSVN5dYO.js";
import { n as formatPairingApproveHint } from "../../helpers-C08KhCf8.js";
import { d as getChatChannelMeta } from "../../core-BulOgDaX.js";
import { t as formatCliCommand } from "../../command-format-Dq_zy1OL.js";
import { t as detectBinary } from "../../detect-binary-BnHu3Jgo.js";
import { t as formatDocsLink } from "../../links-DFMYiV7c.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-CTAOWeji.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-CmF-3zPi.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-DaMnlIWq.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-CcB8QzAb.js";
import { a as resolveSignalAccount, c as probeSignal, i as resolveDefaultSignalAccountId, n as listEnabledSignalAccounts, o as SignalAccountConfig, r as listSignalAccountIds, t as ResolvedSignalAccount } from "../../accounts-DkW-321V.js";
import { a as sendMessageSignal, f as monitorSignalProvider, p as signalMessageActions, u as resolveSignalReactionLevel } from "../../send-DH3UxPfS.js";
import { c as installSignalCli, n as normalizeSignalMessagingTarget, t as looksLikeSignalTargetId } from "../../normalize-DQ2m-PW1.js";
import { i as sendReactionSignal, r as removeReactionSignal } from "../../send-reactions-D_qY2m88.js";

//#region extensions/signal/src/runtime.d.ts
declare const setSignalRuntime: (next: PluginRuntime) => void, clearSignalRuntime: () => void;
//#endregion
export { type ChannelMessageActionAdapter, type ChannelPlugin, DEFAULT_ACCOUNT_ID, type OpenClawConfig, type OpenClawPluginApi, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type ResolvedSignalAccount, type SignalAccountConfig, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };