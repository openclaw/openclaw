import { t as formatCliCommand } from "../../command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "../../links-Dz4PCYCN.js";
import { l as normalizeE164 } from "../../utils-CpmNtyoq.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-BvWy-UYr.js";
import { a as chunkText } from "../../chunk-CrYIBV5V.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-jWYQM06D.js";
import { n as formatPairingApproveHint } from "../../helpers-B3uOXyyz.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-BuWLgIX7.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-iIQ2C2CC.js";
import { c as getChatChannelMeta } from "../../core-D3B0oqI3.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-CSfjApnh.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-DekvNhST.js";
import { t as detectBinary } from "../../detect-binary-B7HrAh9M.js";
import "../../setup-tools-uVyuc4d_.js";
import "../../reply-runtime-fIz_J5OU.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-B6CavSZQ.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-Btn1csDe.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-Drvd6qXd.js";
import "../../channel-status-7KUVffLE.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-CTX_dhcp.js";
import "../../text-utility-runtime-CmVRVZ7i.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-Bc_q568q.js";
import { d as normalizeSignalMessagingTarget, u as looksLikeSignalTargetId } from "../../identity-CRzufYv1.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-Bei0WvvM.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-DnYcljBh.js";
import "../../config-api-B6oR8Zs2.js";
import { r as installSignalCli } from "../../install-signal-cli-DLwJmZAd.js";
import { t as monitorSignalProvider } from "../../monitor-aCT2k4jX.js";
import { t as sendMessageSignal } from "../../send-3MXmUgXx.js";
import { t as probeSignal } from "../../probe-ccDzLKk3.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
