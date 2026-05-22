import { t as formatCliCommand } from "../../command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "../../links-Dz4PCYCN.js";
import { l as normalizeE164 } from "../../utils-CpmNtyoq.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DfoOcZXb.js";
import { a as chunkText } from "../../chunk-BuS2YcmM.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-V1PIzdIZ.js";
import { n as formatPairingApproveHint } from "../../helpers-B1IM5IVe.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-6o9dmHZ0.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-Cw1V9qa9.js";
import { c as getChatChannelMeta } from "../../core-Cuiiy1ZS.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-MAmQRWGj.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-Bs9eiP0M.js";
import { t as detectBinary } from "../../detect-binary-BrYCkWPj.js";
import "../../setup-tools-Da4Wzx26.js";
import "../../reply-runtime-BhjoljqX.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-B14sZn5Z.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-BLG_q0yv.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-Csewe3pX.js";
import "../../channel-status-BrGRj_08.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-BcAkK-Ic.js";
import "../../text-utility-runtime-DSLVVoqA.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-CLxpCWuP.js";
import { d as normalizeSignalMessagingTarget, u as looksLikeSignalTargetId } from "../../identity-VEMieUit.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-YUuanQsf.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-rR90zZHx.js";
import "../../config-api-ARxiN5jP.js";
import { r as installSignalCli } from "../../install-signal-cli-tdYPmO8Y.js";
import { t as monitorSignalProvider } from "../../monitor-D0SB9qX0.js";
import { t as sendMessageSignal } from "../../send-AexTiDor.js";
import { t as probeSignal } from "../../probe-Bqzz1nIa.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
