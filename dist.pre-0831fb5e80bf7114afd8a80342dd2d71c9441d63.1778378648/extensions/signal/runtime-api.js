import { t as formatCliCommand } from "../../command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "../../links-p_GoHtCP.js";
import { l as normalizeE164 } from "../../utils-927g1oFZ.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { o as SignalConfigSchema } from "../../zod-schema.providers-whatsapp-Chk998Rz.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DYzVFvFQ.js";
import { a as chunkText } from "../../chunk-WLwao7GS.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-ulMlBFbn.js";
import { n as formatPairingApproveHint } from "../../helpers-jZ7BUHHD.js";
import "../../text-runtime-Dm9-PE_c.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-B6ZzZs6-.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-B9--ofM6.js";
import { c as getChatChannelMeta } from "../../core-X81hhXAW.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-BY975gH9.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-ECBEj96A.js";
import { t as detectBinary } from "../../detect-binary-CXNCiPxk.js";
import "../../setup-tools-C8oYoVB1.js";
import "../../reply-runtime-DFKT47F1.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-BzgZghzj.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-C5_Dm1pD.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-EU2hrlO2.js";
import "../../channel-status-B1B6b1FE.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-BiRgEjBE.js";
import { d as looksLikeSignalTargetId, f as normalizeSignalMessagingTarget } from "../../identity-D7N-dcvt.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-CmTQ2Ope.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-gSRCGYtj.js";
import "../../config-api-CaDxCn3D.js";
import { r as installSignalCli } from "../../install-signal-cli-vNer-lw0.js";
import { t as monitorSignalProvider } from "../../monitor-BGO8Xfxy.js";
import { t as sendMessageSignal } from "../../send-BAcvuxNV.js";
import { t as probeSignal } from "../../probe-ByXMfXa8.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
