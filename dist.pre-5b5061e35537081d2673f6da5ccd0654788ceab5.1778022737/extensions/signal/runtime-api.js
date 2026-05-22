import { t as formatDocsLink } from "../../links-BszRQhGa.js";
import { t as formatCliCommand } from "../../command-format-DXo6xcsW.js";
import { l as normalizeE164 } from "../../utils-CCskKJVV.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-DUpVOe8L.js";
import { r as buildChannelConfigSchema } from "../../config-schema-C2n-k4o1.js";
import { o as SignalConfigSchema } from "../../zod-schema.providers-whatsapp-BGDCDnty.js";
import { a as chunkText } from "../../chunk-D2H_19Xb.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-DyBVgEMG.js";
import { n as formatPairingApproveHint } from "../../helpers-DrODJMht.js";
import "../../text-runtime-icMZVCaq.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-DdpC30u1.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-t5I1EDve.js";
import { c as getChatChannelMeta } from "../../core-C8nU4cB6.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-BToSvHpc.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-BjigiEZz.js";
import { t as resolveChannelMediaMaxBytes } from "../../media-limits-D0rXBd6e.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-B7fZ2qTh.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-BvzPNo7p.js";
import { t as detectBinary } from "../../detect-binary-UN2KbLBa.js";
import "../../setup-tools-DdUgobpV.js";
import "../../reply-runtime-BLToE2jg.js";
import "../../media-runtime-5rxXL-Os.js";
import "../../channel-status-be0NZxcV.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-BOLNSiam.js";
import { d as looksLikeSignalTargetId, f as normalizeSignalMessagingTarget } from "../../identity-DxQC-2nL.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-Bzz-qmrS.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-wM3Ntk9v.js";
import "../../config-api-CJ19W2Ng.js";
import { r as installSignalCli } from "../../install-signal-cli-BP7Ux4gq.js";
import { t as monitorSignalProvider } from "../../monitor-DUzIkyPU.js";
import { t as sendMessageSignal } from "../../send-DM1J-duH.js";
import { t as probeSignal } from "../../probe-DCM9J4LM.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
