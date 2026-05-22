import { t as formatCliCommand } from "../../command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "../../links-Dz4PCYCN.js";
import { l as normalizeE164 } from "../../utils-CpmNtyoq.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-gd9RYI9s.js";
import { a as chunkText } from "../../chunk-B9TeD1Cb.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-2u-Tk5Gc.js";
import { n as formatPairingApproveHint } from "../../helpers-BlOFYFV6.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-DpL4qtml.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-CH11mQRi.js";
import { c as getChatChannelMeta } from "../../core-I3FPAipY.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-Ck0e4Li2.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-BUzFlosd.js";
import { t as detectBinary } from "../../detect-binary-BT5YvH4U.js";
import "../../setup-tools-CFu9Oopm.js";
import "../../reply-runtime-FOHsR6nY.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-CBarHxr2.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-Jq5bmS3N.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-DC20QesH.js";
import "../../channel-status-DsH1v7Er.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-C2N3DZvi.js";
import "../../text-utility-runtime-B64bksiI.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-gpfdBGki.js";
import { d as normalizeSignalMessagingTarget, u as looksLikeSignalTargetId } from "../../identity-BqTze4O5.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-Bt3mW697.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-C_BrYjnP.js";
import "../../config-api-ChdIRnKN.js";
import { r as installSignalCli } from "../../install-signal-cli-Bo1OF0D6.js";
import { t as monitorSignalProvider } from "../../monitor-DrWDw1kC.js";
import { t as sendMessageSignal } from "../../send-CK61755M.js";
import { t as probeSignal } from "../../probe-DA1gqK90.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
