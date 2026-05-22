import { t as formatCliCommand } from "../../command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "../../links-Dz4PCYCN.js";
import { l as normalizeE164 } from "../../utils-CpmNtyoq.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-Bte5Yg6T.js";
import { a as chunkText } from "../../chunk-DoeRNEZX.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-DEY-Ez7N.js";
import { n as formatPairingApproveHint } from "../../helpers-D8kE2zJ5.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-DDEfka3K.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-iIQ2C2CC.js";
import { c as getChatChannelMeta } from "../../core-CDnkZFnA.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-CSfjApnh.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-DekvNhST.js";
import { t as detectBinary } from "../../detect-binary-3rcnHldR.js";
import "../../setup-tools-C91fUtSR.js";
import "../../reply-runtime-CQ7UQ19G.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime--1rTkfXw.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-DAZut6Hh.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-MWz4ebYh.js";
import "../../channel-status-D8Np2Hnc.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-CwSmAESn.js";
import "../../text-utility-runtime-Cbt5ZyEv.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-BJD7-Qaj.js";
import { d as normalizeSignalMessagingTarget, u as looksLikeSignalTargetId } from "../../identity-Dq4VXhMI.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-BLEV912q.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-BezIR0B7.js";
import "../../config-api-2VOLC01J.js";
import { r as installSignalCli } from "../../install-signal-cli-BzjV3b8v.js";
import { t as monitorSignalProvider } from "../../monitor-T8s-f4Tp.js";
import { t as sendMessageSignal } from "../../send-Biws3cya.js";
import { t as probeSignal } from "../../probe-DwlvLA53.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
