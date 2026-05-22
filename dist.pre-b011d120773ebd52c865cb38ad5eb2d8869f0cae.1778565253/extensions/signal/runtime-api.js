import { t as formatCliCommand } from "../../command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "../../links-p_GoHtCP.js";
import { l as normalizeE164 } from "../../utils-CRkrr5e6.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { o as SignalConfigSchema } from "../../zod-schema.providers-whatsapp-C5Cf1lvs.js";
import { r as buildChannelConfigSchema } from "../../config-schema-RuhSQMup.js";
import { a as chunkText } from "../../chunk-Cwj1J7Kz.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-DPaS6NvZ.js";
import { n as formatPairingApproveHint } from "../../helpers-tqh3lXOw.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-D4jp1qV3.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-CDpLJ1PE.js";
import { c as getChatChannelMeta } from "../../core-DCSJmjRQ.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-C20iH_sr.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-BRW-ZbWi.js";
import { t as detectBinary } from "../../detect-binary-DiiAyPby.js";
import "../../setup-tools-DvZ1VoPO.js";
import "../../reply-runtime-aaib4-Ld.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-Bkhg9eNT.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-BeaXTGbH.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-CMJ5OzbS.js";
import "../../channel-status-Dj8mUppJ.js";
import "../../text-utility-runtime-Bx8a2TNS.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-wN92PLX0.js";
import { d as normalizeSignalMessagingTarget, u as looksLikeSignalTargetId } from "../../identity-ADaIJnXU.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-BYBApKM-.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-nXpuK4gu.js";
import "../../config-api-DqryWxPs.js";
import { r as installSignalCli } from "../../install-signal-cli-BgDfGXvv.js";
import { t as monitorSignalProvider } from "../../monitor-CVm_S2Sn.js";
import { t as sendMessageSignal } from "../../send-B9VOU9Bg.js";
import { t as probeSignal } from "../../probe-DuOX_Plv.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
