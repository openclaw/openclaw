import { t as formatCliCommand } from "../../command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "../../links-Dz4PCYCN.js";
import { l as normalizeE164 } from "../../utils-CpmNtyoq.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-gd9RYI9s.js";
import { a as chunkText } from "../../chunk-o-kwX4lv.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-2u-Tk5Gc.js";
import { n as formatPairingApproveHint } from "../../helpers-BlOFYFV6.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-DpL4qtml.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-CH11mQRi.js";
import { c as getChatChannelMeta } from "../../core-DfXPRYzR.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-Ck0e4Li2.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-BUzFlosd.js";
import { t as detectBinary } from "../../detect-binary-XL0HMrQT.js";
import "../../setup-tools-BRfafuRU.js";
import "../../reply-runtime-b9sSSJJu.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-eri84b_Q.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-5hyKIuvT.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-BunFlW3J.js";
import "../../channel-status-DYYgC8Iv.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-DKky0-Dd.js";
import "../../text-utility-runtime-mw4Gc_Lc.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-DKDSqJbi.js";
import { d as normalizeSignalMessagingTarget, u as looksLikeSignalTargetId } from "../../identity-BxAfh-1n.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-CmbbG_hz.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-Vu0HBW78.js";
import "../../config-api-BnaUyExR.js";
import { r as installSignalCli } from "../../install-signal-cli-DgD1jYGf.js";
import { t as monitorSignalProvider } from "../../monitor-fjhG7Gq3.js";
import { t as sendMessageSignal } from "../../send-H012w0md.js";
import { t as probeSignal } from "../../probe-CWh2BtsM.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
