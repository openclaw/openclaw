import { t as formatCliCommand } from "../../command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "../../links-p_GoHtCP.js";
import { l as normalizeE164 } from "../../utils-DG9b7Tlg.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { o as SignalConfigSchema } from "../../zod-schema.providers-whatsapp-CBTMFdxJ.js";
import { r as buildChannelConfigSchema } from "../../config-schema-BzjbZqXE.js";
import { a as chunkText } from "../../chunk-DNRzZy_M.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-Dd-Yltzo.js";
import { n as formatPairingApproveHint } from "../../helpers-BH5_-HwZ.js";
import "../../text-runtime-BFTVdjnu.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-JAQG2I5N.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-CmIT7u8P.js";
import { c as getChatChannelMeta } from "../../core-DrKqe3wh.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-D7S_cOrU.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-B7GObW62.js";
import { t as detectBinary } from "../../detect-binary-OLPQEVlf.js";
import "../../setup-tools-CiieYHrg.js";
import "../../reply-runtime-BDaXbSNv.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-Dd0DSUkR.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-DmHuSBT7.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-Csn-585_.js";
import "../../channel-status-O4BFybJX.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-BLOsFeaK.js";
import { d as looksLikeSignalTargetId, f as normalizeSignalMessagingTarget } from "../../identity-BPstgWrl.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-D0io4M2E.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-DE869Siy.js";
import "../../config-api-CLAYcJ61.js";
import { r as installSignalCli } from "../../install-signal-cli-ZkBHg2zu.js";
import { t as monitorSignalProvider } from "../../monitor-BuF4pNaT.js";
import { t as sendMessageSignal } from "../../send-B5OEgB-j.js";
import { t as probeSignal } from "../../probe-w1ybYpLi.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
