import { t as formatDocsLink } from "../../links-BszRQhGa.js";
import { t as formatCliCommand } from "../../command-format-DXo6xcsW.js";
import { l as normalizeE164 } from "../../utils-CCskKJVV.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-fkYplFFW.js";
import { r as buildChannelConfigSchema } from "../../config-schema-Cv6_wz1q.js";
import { o as SignalConfigSchema } from "../../zod-schema.providers-whatsapp-BGYiCmAE.js";
import { a as chunkText } from "../../chunk-DVhbCEt5.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-lZfrUYAN.js";
import { n as formatPairingApproveHint } from "../../helpers-DSAkXmYY.js";
import "../../text-runtime-CFBwIeh_.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-q-T0QfDn.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-Bdc21zG9.js";
import { c as getChatChannelMeta } from "../../core-DJOjUZtD.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-zhyGrZKn.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-DO2R0ku6.js";
import { t as resolveChannelMediaMaxBytes } from "../../media-limits-9HNm5nRX.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-CQAMfMKv.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-Bt2mvr5s.js";
import { t as detectBinary } from "../../detect-binary-csFNjV9M.js";
import "../../setup-tools-C6__pG4W.js";
import "../../reply-runtime-CAcKebkN.js";
import "../../media-runtime-BFyCHDx4.js";
import "../../channel-status-C5TtpNEM.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-BMBxW8eq.js";
import { d as looksLikeSignalTargetId, f as normalizeSignalMessagingTarget } from "../../identity-DWAX4jgg.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-C-9qnTiQ.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-BOaju1os.js";
import "../../config-api-DDbUHG4o.js";
import { r as installSignalCli } from "../../install-signal-cli-kP0h9GIA.js";
import { t as monitorSignalProvider } from "../../monitor-DeNojJec.js";
import { t as sendMessageSignal } from "../../send-Dlivoj-x.js";
import { t as probeSignal } from "../../probe-BVeKsBqM.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
