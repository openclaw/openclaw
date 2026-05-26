import { t as formatCliCommand } from "../../command-format-BPjMauol.js";
import { t as formatDocsLink } from "../../links-CM5vg8_V.js";
import { l as normalizeE164 } from "../../utils-sBTEdeml.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-B32J-iNN.js";
import { r as buildChannelConfigSchema } from "../../config-schema-ChfiQrSg.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-CmZDlIwd.js";
import { a as chunkText } from "../../chunk-IIklKK4Y.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-a_k3n5UT.js";
import { n as formatPairingApproveHint } from "../../helpers-CswdXPdi.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-DBTUnI0T.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-BC9z9VvG.js";
import { c as getChatChannelMeta } from "../../core-kXuNbs5U.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-Cezm5nT2.js";
import { t as detectBinary } from "../../detect-binary-C4HxcF68.js";
import "../../setup-tools-DuiMNzp5.js";
import "../../reply-runtime-DbNBMCwV.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-BheBFFxc.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-C9w9gv4K.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-CnvYAK73.js";
import "../../channel-status-pVVcmlap.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-CA36mrPs.js";
import "../../text-utility-runtime-CaGXarh9.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-D8MTjG-n.js";
import { d as normalizeSignalMessagingTarget, u as looksLikeSignalTargetId } from "../../identity-DUK4sesG.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-D7xaIBG_.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-5LxX-D_X.js";
import "../../config-api-YScTBeDg.js";
import { r as installSignalCli } from "../../install-signal-cli-KHOI-AFy.js";
import { t as monitorSignalProvider } from "../../monitor-D4sgH3mb.js";
import { t as sendMessageSignal } from "../../send-DUOLoOIe.js";
import { t as probeSignal } from "../../probe-BdZlSBF9.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
