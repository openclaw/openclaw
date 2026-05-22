import { i as OpenClawConfig } from "../../types.openclaw-DNoZmPZ8.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-CA4LSr_f.js";
import { h as chunkText } from "../../outbound.types-BK1BT_uT.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-yC1NCFUF.js";
import { v as OpenClawPluginApi } from "../../types-CT4HF0Ri.js";
import { l as normalizeE164 } from "../../utils-CHPoBJa0.js";
import { n as ChannelPlugin } from "../../types.public-hz1J9-y_.js";
import { n as PluginRuntime } from "../../types-DLVUU0yv.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-StrYOgR3.js";
import { r as buildChannelConfigSchema } from "../../config-schema-BrlMkD9Y.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-BwzkZeC5.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-Bz9SqD8D.js";
import { n as formatPairingApproveHint } from "../../helpers-C9XNXl3w.js";
import { d as getChatChannelMeta } from "../../core-Da-jTs2y.js";
import { t as formatDocsLink } from "../../links-xcfLpnpH.js";
import { t as formatCliCommand } from "../../command-format-5_6gGDI7.js";
import { E as resolveChannelMediaMaxBytes } from "../../media-runtime-BFGbtXof.js";
import { t as detectBinary } from "../../detect-binary-CeLj_sGZ.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-B83KFe4R.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-BRWXVnED.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-BEGpXRZl.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-GcbKfZOl.js";
import { a as resolveSignalAccount, c as probeSignal, i as resolveDefaultSignalAccountId, n as listEnabledSignalAccounts, o as SignalAccountConfig, r as listSignalAccountIds, t as ResolvedSignalAccount } from "../../accounts-C74Mqb-B.js";
import { a as sendMessageSignal, f as monitorSignalProvider, p as signalMessageActions, u as resolveSignalReactionLevel } from "../../send-Bn-7offc.js";
import { c as installSignalCli, n as normalizeSignalMessagingTarget, t as looksLikeSignalTargetId } from "../../normalize-BDXWuy3e.js";
import { i as sendReactionSignal, r as removeReactionSignal } from "../../send-reactions-DWXHfXt3.js";

//#region extensions/signal/src/runtime.d.ts
declare const setSignalRuntime: (next: PluginRuntime) => void, clearSignalRuntime: () => void;
//#endregion
export { type ChannelMessageActionAdapter, type ChannelPlugin, DEFAULT_ACCOUNT_ID, type OpenClawConfig, type OpenClawPluginApi, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type ResolvedSignalAccount, type SignalAccountConfig, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };