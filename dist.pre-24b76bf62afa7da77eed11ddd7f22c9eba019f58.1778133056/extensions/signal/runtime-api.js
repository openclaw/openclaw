import { t as formatDocsLink } from "../../links-BszRQhGa.js";
import { t as formatCliCommand } from "../../command-format-DXo6xcsW.js";
import { l as normalizeE164 } from "../../utils-CCskKJVV.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-05Z3mmpO.js";
import { o as SignalConfigSchema } from "../../zod-schema.providers-whatsapp-B8jvaNbU.js";
import { r as buildChannelConfigSchema } from "../../config-schema-CLM6ogpT.js";
import { a as chunkText } from "../../chunk-C2kl4p0h.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-MniV1jJS.js";
import { n as formatPairingApproveHint } from "../../helpers-BUOSsuwP.js";
import "../../text-runtime-C_zPTqpT.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-DW8jXNGU.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-D5cShzie.js";
import { c as getChatChannelMeta } from "../../core-BsEhQ_g7.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-Wij_b93b.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-CaaZXWTO.js";
import { t as resolveChannelMediaMaxBytes } from "../../media-limits-LwaYNoUx.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-DDuxp0PB.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-CaAM_77P.js";
import { t as detectBinary } from "../../detect-binary-D4X0A8De.js";
import "../../setup-tools-1f3J-pTv.js";
import "../../reply-runtime-CvbWldb4.js";
import "../../media-runtime-CfGiZyk2.js";
import "../../channel-status-Bs_3DYkc.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-Cphq5imu.js";
import { d as looksLikeSignalTargetId, f as normalizeSignalMessagingTarget } from "../../identity-CoxREaKC.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-X025iX8m.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-Dm_JNCyd.js";
import "../../config-api-DQwIP-3H.js";
import { r as installSignalCli } from "../../install-signal-cli-DSxR9RFE.js";
import { t as monitorSignalProvider } from "../../monitor-DIEkSYcl.js";
import { t as sendMessageSignal } from "../../send-DEIT3B80.js";
import { t as probeSignal } from "../../probe-ZVp72hjd.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
