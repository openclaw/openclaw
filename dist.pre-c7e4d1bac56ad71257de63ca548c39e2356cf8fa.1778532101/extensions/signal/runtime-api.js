import { t as formatDocsLink } from "../../links-dQIIPEtq.js";
import { t as formatCliCommand } from "../../command-format-ut6bcRZg.js";
import { l as normalizeE164 } from "../../utils-D5swhEXt.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-Bj7l9NI7.js";
import { o as SignalConfigSchema } from "../../zod-schema.providers-whatsapp-CSUEJ-NX.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DZSQT0EH.js";
import { a as chunkText } from "../../chunk-Bkxjj_pw.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-CWH9LKMY.js";
import { n as formatPairingApproveHint } from "../../helpers-Oaj_3a8N.js";
import "../../text-runtime-FOsx_CPC.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-DgbrLxf1.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-CESD8ZBk.js";
import { c as getChatChannelMeta } from "../../core-B2c9_N7p.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-67Vxx2iX.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-CecGaqtk.js";
import { t as resolveChannelMediaMaxBytes } from "../../media-limits-DkpcBnqF.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-CluH3mwm.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-ml9CygpH.js";
import { t as detectBinary } from "../../detect-binary-g5lyBGFE.js";
import "../../setup-tools-kW9g8oln.js";
import "../../reply-runtime-Tb73eWN3.js";
import "../../media-runtime-Doi16sSJ.js";
import "../../channel-status-D_w9jtCo.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-PVperMO5.js";
import { d as looksLikeSignalTargetId, f as normalizeSignalMessagingTarget } from "../../identity-CbjjuCqn.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-KanI5zTa.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-tqRWjqoR.js";
import "../../config-api-C82rdAuM.js";
import { r as installSignalCli } from "../../install-signal-cli-BwS7w7cm.js";
import { t as monitorSignalProvider } from "../../monitor-BPv1g2B2.js";
import { t as sendMessageSignal } from "../../send-DznCXZ99.js";
import { t as probeSignal } from "../../probe-DJFMoAU5.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
