import { t as formatCliCommand } from "../../command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "../../links-Dz4PCYCN.js";
import { l as normalizeE164 } from "../../utils-CpmNtyoq.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DxANcyv3.js";
import { a as chunkText } from "../../chunk-ekIU3ke9.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-DdPFnH0c.js";
import { n as formatPairingApproveHint } from "../../helpers-GclTmnpB.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-D2X07dxe.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-BGMnNXnl.js";
import { c as getChatChannelMeta } from "../../core-BSbJPGGu.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-2ORR7yfg.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-RNNssS02.js";
import { t as detectBinary } from "../../detect-binary-GBdB5i-Y.js";
import "../../setup-tools-Ct-pn7c9.js";
import "../../reply-runtime-CDLAGLjn.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-BqjAMS-d.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-CjLaVP41.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-DoFEa01y.js";
import "../../channel-status-CoOBYmoa.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-vMxbl2Zb.js";
import "../../text-utility-runtime-C7HSc_wz.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-BvCmBnBV.js";
import { d as normalizeSignalMessagingTarget, u as looksLikeSignalTargetId } from "../../identity-BF8_ajGz.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-Dx6mxBz3.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-BkTUQZnZ.js";
import "../../config-api-BcbeYGPe.js";
import { r as installSignalCli } from "../../install-signal-cli-xmkqHcJs.js";
import { t as monitorSignalProvider } from "../../monitor-5D7s9dVw.js";
import { t as sendMessageSignal } from "../../send-DuhMOhU0.js";
import { t as probeSignal } from "../../probe-CXjqvnYl.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
