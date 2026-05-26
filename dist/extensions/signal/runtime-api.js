import { t as formatCliCommand } from "../../command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "../../links-Dz4PCYCN.js";
import { l as normalizeE164 } from "../../utils-CKsuXgDI.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-CwBWagLE.js";
import { o as SignalConfigSchema } from "../../zod-schema.providers-whatsapp-BElo3xB4.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DftNRjDz.js";
import { a as chunkText } from "../../chunk-CGVwhsnj.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-DGJjji5v.js";
import { n as formatPairingApproveHint } from "../../helpers-Pya1IDj5.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-jDHhDDcb.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-D1h9Zq-C.js";
import { c as getChatChannelMeta } from "../../core-BPnS_bab.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-Cigg_Veg.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-BoxMLuus.js";
import { t as detectBinary } from "../../detect-binary-D0DCWl0p.js";
import "../../setup-tools-WOmaR-iv.js";
import "../../reply-runtime-Cnhadp3p.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-DWh6m_8p.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-C5_Dm1pD.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-Dk-3BT6p.js";
import "../../channel-status-DQzE7laT.js";
import "../../text-utility-runtime-CG5gZFsT.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-1GlRRBqz.js";
import { d as normalizeSignalMessagingTarget, u as looksLikeSignalTargetId } from "../../identity-BtCkAf6q.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-Zdzq5Ojv.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-HzkMqDqD.js";
import "../../config-api-DYpQfRsQ.js";
import { r as installSignalCli } from "../../install-signal-cli-DRg3mN1j.js";
import { t as monitorSignalProvider } from "../../monitor-FGgnsTZf.js";
import { t as sendMessageSignal } from "../../send-DWcqjk0T.js";
import { t as probeSignal } from "../../probe-DENyGr9W.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
