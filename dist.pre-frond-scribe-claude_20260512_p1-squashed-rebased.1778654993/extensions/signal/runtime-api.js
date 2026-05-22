import { t as formatCliCommand } from "../../command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "../../links-p_GoHtCP.js";
import { l as normalizeE164 } from "../../utils-CRkrr5e6.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { o as SignalConfigSchema } from "../../zod-schema.providers-whatsapp-CKJdvmco.js";
import { r as buildChannelConfigSchema } from "../../config-schema-bYjGMbfy.js";
import { a as chunkText } from "../../chunk-CVo5aUOt.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-DzujJt3a.js";
import { n as formatPairingApproveHint } from "../../helpers-BDbgzl55.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-C4enmKMV.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-CIcTlEPx.js";
import { c as getChatChannelMeta } from "../../core-DJqj23Pm.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-OWAYvd1I.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-BeBJUxpM.js";
import { t as detectBinary } from "../../detect-binary-tEQKvmVw.js";
import "../../setup-tools-DZMtGFrC.js";
import "../../reply-runtime-4OzdOZ9p.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-DZ1nM-JH.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-Uouqymoo.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-Dzp0y1UL.js";
import "../../channel-status-v0vCi1Fh.js";
import "../../text-utility-runtime-BBxqlf_T.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-5-y0TLa5.js";
import { d as normalizeSignalMessagingTarget, u as looksLikeSignalTargetId } from "../../identity-Bs0vRhu6.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-Dt29KH0n.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-DKyqBx8f.js";
import "../../config-api-BrJfCHpf.js";
import { r as installSignalCli } from "../../install-signal-cli-ChU1KNEv.js";
import { t as monitorSignalProvider } from "../../monitor-cN2pegNr.js";
import { t as sendMessageSignal } from "../../send-B1-d33y8.js";
import { t as probeSignal } from "../../probe-CqHH28Bz.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
