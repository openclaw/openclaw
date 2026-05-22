import { t as formatCliCommand } from "../../command-format-BPjMauol.js";
import { t as formatDocsLink } from "../../links-CM5vg8_V.js";
import { l as normalizeE164 } from "../../utils-DX02THHb.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-B32J-iNN.js";
import { r as buildChannelConfigSchema } from "../../config-schema-CmARlg6A.js";
import { a as chunkText } from "../../chunk-BUVFtz91.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-a_k3n5UT.js";
import { n as formatPairingApproveHint } from "../../helpers-CswdXPdi.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-DBTUnI0T.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-BC9z9VvG.js";
import { c as getChatChannelMeta } from "../../core-DihfuisK.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-Cezm5nT2.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-CmZDlIwd.js";
import { t as detectBinary } from "../../detect-binary-LBNK2ydh.js";
import "../../setup-tools-CXtm0B5Q.js";
import "../../reply-runtime-DIT1as3t.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-BRqBxHRo.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-C9w9gv4K.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-CkYd4QGd.js";
import "../../channel-status-Bsp7cc4O.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-DLot5wXA.js";
import "../../text-utility-runtime-BHBeoiIN.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-BoqEXGbX.js";
import { d as normalizeSignalMessagingTarget, u as looksLikeSignalTargetId } from "../../identity-F3GenNJh.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-BMwbix_8.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-CjLtp1El.js";
import "../../config-api-BmNUflU3.js";
import { r as installSignalCli } from "../../install-signal-cli-CFjxL5vj.js";
import { t as monitorSignalProvider } from "../../monitor-CsVuyC5B.js";
import { t as sendMessageSignal } from "../../send-BRHNx68N.js";
import { t as probeSignal } from "../../probe-C4MBmIvx.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
