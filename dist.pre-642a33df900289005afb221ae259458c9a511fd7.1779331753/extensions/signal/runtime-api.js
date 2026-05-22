import { t as formatCliCommand } from "../../command-format-BPjMauol.js";
import { t as formatDocsLink } from "../../links-CM5vg8_V.js";
import { l as normalizeE164 } from "../../utils-BlCbsks0.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-B32J-iNN.js";
import { r as buildChannelConfigSchema } from "../../config-schema-tWQ-m82m.js";
import { a as chunkText } from "../../chunk-CXXovQEC.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-a_k3n5UT.js";
import { n as formatPairingApproveHint } from "../../helpers-CswdXPdi.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-DBTUnI0T.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-BC9z9VvG.js";
import { c as getChatChannelMeta } from "../../core-npnlPG1m.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-Cezm5nT2.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-CmZDlIwd.js";
import { t as detectBinary } from "../../detect-binary-paUqc5Kv.js";
import "../../setup-tools-C6vDTstI.js";
import "../../reply-runtime-BclblUav.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-D2Qs-Ei3.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-C9w9gv4K.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-CkwlpDZd.js";
import "../../channel-status-CgLm1zs_.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-X2kV9Vl4.js";
import "../../text-utility-runtime-jwGPYr8C.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-D55dcCj-.js";
import { d as normalizeSignalMessagingTarget, u as looksLikeSignalTargetId } from "../../identity-CGbTKzH8.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-Ctz0_O_M.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-DV1czRqG.js";
import "../../config-api-CUijBwo1.js";
import { r as installSignalCli } from "../../install-signal-cli-Cg6nHr3t.js";
import { t as monitorSignalProvider } from "../../monitor-CLe9NFsC.js";
import { t as sendMessageSignal } from "../../send-pCIXCBMB.js";
import { t as probeSignal } from "../../probe-DwAtKQSf.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
