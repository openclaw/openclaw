import { t as formatCliCommand } from "../../command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "../../links-Dz4PCYCN.js";
import { l as normalizeE164 } from "../../utils-CpmNtyoq.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-N0fs4S4x.js";
import { a as chunkText } from "../../chunk-CWxm2ihr.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-B10RRAhh.js";
import { n as formatPairingApproveHint } from "../../helpers-C1eW-uTR.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-G0wS2fWR.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-C2owaOKH.js";
import { c as getChatChannelMeta } from "../../core-PZ9jJhPV.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-DpA2UZdL.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-apkf7dQf.js";
import { t as detectBinary } from "../../detect-binary-Bj5ltyGZ.js";
import "../../setup-tools-NDhWakWP.js";
import "../../reply-runtime-BTJUa9vX.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime--x8BthNJ.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-DpXnmJCi.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-Cwggsbh4.js";
import "../../channel-status-CkID1ohH.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-DV8onDJE.js";
import "../../text-utility-runtime-pvPz52bQ.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-CQeHkr0d.js";
import { d as normalizeSignalMessagingTarget, u as looksLikeSignalTargetId } from "../../identity-BNBRoAHJ.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-CVarKDLo.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-qDA7yB4P.js";
import "../../config-api-D11LbmRQ.js";
import { r as installSignalCli } from "../../install-signal-cli-DMDAcn-u.js";
import { t as monitorSignalProvider } from "../../monitor-xjkTXlDi.js";
import { t as sendMessageSignal } from "../../send-DX7pOe78.js";
import { t as probeSignal } from "../../probe-DcNeZyr3.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
