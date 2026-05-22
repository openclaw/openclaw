import { t as formatCliCommand } from "../../command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "../../links-Dz4PCYCN.js";
import { l as normalizeE164 } from "../../utils-CpmNtyoq.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-gd9RYI9s.js";
import { a as chunkText } from "../../chunk-DUB04dEk.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-VqWhr_tS.js";
import { n as formatPairingApproveHint } from "../../helpers-BJ8ZIvo-.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-CsvqyD6p.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-Dc-_HkVh.js";
import { c as getChatChannelMeta } from "../../core-DFuaL5sM.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-BPbfSxdB.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-Cw7QcSjj.js";
import { t as detectBinary } from "../../detect-binary-BzpaO4O2.js";
import "../../setup-tools-PyDfaoXW.js";
import "../../reply-runtime-bpPUxFjQ.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-C_YRRJZQ.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-B6vSZJO3.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-CL121ZpD.js";
import "../../channel-status-C1bs_3mh.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-CaAok3C8.js";
import "../../text-utility-runtime-CHBV36pg.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-xXQt0qtI.js";
import { d as normalizeSignalMessagingTarget, u as looksLikeSignalTargetId } from "../../identity-BUcvGkea.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-BN_iWlWP.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-DscOpqhA.js";
import "../../config-api-D911nUJZ.js";
import { r as installSignalCli } from "../../install-signal-cli-BB0L7RHR.js";
import { t as monitorSignalProvider } from "../../monitor-C4nYXqBP.js";
import { t as sendMessageSignal } from "../../send-Nnrgadd7.js";
import { t as probeSignal } from "../../probe-Evfa1UMZ.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
