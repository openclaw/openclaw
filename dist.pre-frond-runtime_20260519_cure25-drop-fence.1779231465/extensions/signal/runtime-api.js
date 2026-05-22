import { t as formatCliCommand } from "../../command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "../../links-Dz4PCYCN.js";
import { l as normalizeE164 } from "../../utils-CpmNtyoq.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-gd9RYI9s.js";
import { a as chunkText } from "../../chunk-DUB04dEk.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-VqWhr_tS.js";
import { n as formatPairingApproveHint } from "../../helpers-BJ8ZIvo-.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-CBVJeodZ.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-BMr3e_P1.js";
import { c as getChatChannelMeta } from "../../core-BqKK0e13.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-Cyf2sWjo.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-PqsbAHf-.js";
import { t as detectBinary } from "../../detect-binary-0SJzhatz.js";
import "../../setup-tools-BQjLFfBh.js";
import "../../reply-runtime-DF2U9iRA.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-0W8KVR3F.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-BWpHs4Jo.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-DFnAP_vm.js";
import "../../channel-status-C--eIG63.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-C4yPoZ3d.js";
import "../../text-utility-runtime-B42ItsYy.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-BGtOJfLJ.js";
import { d as normalizeSignalMessagingTarget, u as looksLikeSignalTargetId } from "../../identity-DwBOZAV7.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-wvV6tAwm.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-rkJOSYyB.js";
import "../../config-api-Bap5kblu.js";
import { r as installSignalCli } from "../../install-signal-cli-BKoNVyYu.js";
import { t as monitorSignalProvider } from "../../monitor-iA1-vPmC.js";
import { t as sendMessageSignal } from "../../send-BjhQr0tO.js";
import { t as probeSignal } from "../../probe-CBvulPqK.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
