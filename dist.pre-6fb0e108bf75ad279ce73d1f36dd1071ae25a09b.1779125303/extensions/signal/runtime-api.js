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
import { c as getChatChannelMeta } from "../../core-BeACHtvF.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-Ck0e4Li2.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-BUzFlosd.js";
import { t as detectBinary } from "../../detect-binary-D06_MuRO.js";
import "../../setup-tools-m2EkUEEd.js";
import "../../reply-runtime-DssLgcUS.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-CTGr8VtE.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-BssVwtlc.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-DYX6v68d.js";
import "../../channel-status-DmDLldrU.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-CR_47WNy.js";
import "../../text-utility-runtime-Bj7O9lbY.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-7o6-k-H9.js";
import { d as normalizeSignalMessagingTarget, u as looksLikeSignalTargetId } from "../../identity-DwbvxXz3.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-SLTfCQmD.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-Bzr0Sjrq.js";
import "../../config-api-GkEUhugb.js";
import { r as installSignalCli } from "../../install-signal-cli-Cxe0fWB3.js";
import { t as monitorSignalProvider } from "../../monitor-1JTHxuW4.js";
import { t as sendMessageSignal } from "../../send-BFBuR26v.js";
import { t as probeSignal } from "../../probe-DbFAWQZ1.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
