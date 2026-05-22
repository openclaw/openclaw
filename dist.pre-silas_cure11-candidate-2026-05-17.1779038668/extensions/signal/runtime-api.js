import { t as formatCliCommand } from "../../command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "../../links-Dz4PCYCN.js";
import { l as normalizeE164 } from "../../utils-CpmNtyoq.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-N0fs4S4x.js";
import { a as chunkText } from "../../chunk-BkjHRVGW.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-_ItsKgnM.js";
import { n as formatPairingApproveHint } from "../../helpers-DPsLTTfB.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-PFzg1kdX.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-BELDHN77.js";
import { c as getChatChannelMeta } from "../../core-DlOTX_kM.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-DUe79kGC.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-BCreNQjR.js";
import { t as detectBinary } from "../../detect-binary-vv7ooh92.js";
import "../../setup-tools-DYBRXD_s.js";
import "../../reply-runtime-vwedCes7.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-Cu1-Pffz.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-W_ywCxLU.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-zPU2wFDW.js";
import "../../channel-status-Bf1Fg2Mi.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-BZx-IoDt.js";
import "../../text-utility-runtime-Bq-DXGZB.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-BTaaWhxR.js";
import { d as normalizeSignalMessagingTarget, u as looksLikeSignalTargetId } from "../../identity-CFVrIZuN.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-DZFxlEUC.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-gkwu5HPB.js";
import "../../config-api-Bz2JDigQ.js";
import { r as installSignalCli } from "../../install-signal-cli-CHvEXnwZ.js";
import { t as monitorSignalProvider } from "../../monitor-8FKk13SI.js";
import { t as sendMessageSignal } from "../../send-DamF4rBg.js";
import { t as probeSignal } from "../../probe-CJubkBF5.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
