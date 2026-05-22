import { t as formatCliCommand } from "../../command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "../../links-p_GoHtCP.js";
import { l as normalizeE164 } from "../../utils-927g1oFZ.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { o as SignalConfigSchema } from "../../zod-schema.providers-whatsapp-DgRFv5mw.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DJNyYIkR.js";
import { a as chunkText } from "../../chunk-B_CySsI6.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-aTDBDXfR.js";
import { n as formatPairingApproveHint } from "../../helpers-jkClkdkg.js";
import "../../text-runtime-BwGO-OOf.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-D-h48yjg.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-DbTkc2ow.js";
import { c as getChatChannelMeta } from "../../core-CQ0EhoHb.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-Gsztj7De.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-CQ7g6SEW.js";
import { t as detectBinary } from "../../detect-binary-OwQ3MPCZ.js";
import "../../setup-tools-BmoXGQcA.js";
import "../../reply-runtime-z4EOPSQ1.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-VIdlgue-.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-DJUA4wt9.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-DUEfpOKW.js";
import "../../channel-status-BOptdune.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-isrXge2j.js";
import { d as normalizeSignalMessagingTarget, u as looksLikeSignalTargetId } from "../../identity-BjHb1Aji.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-C5wSCv_7.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-CVNFQoKD.js";
import "../../config-api-D-eG0yew.js";
import { r as installSignalCli } from "../../install-signal-cli-GqzE0wtR.js";
import { t as monitorSignalProvider } from "../../monitor-97kpbDhp.js";
import { t as sendMessageSignal } from "../../send-CImYIXGo.js";
import { t as probeSignal } from "../../probe-C_6OLWIZ.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
