import { t as formatDocsLink } from "../../links-dQIIPEtq.js";
import { t as formatCliCommand } from "../../command-format-ut6bcRZg.js";
import { l as normalizeE164 } from "../../utils-D5swhEXt.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-Bj7l9NI7.js";
import { o as SignalConfigSchema } from "../../zod-schema.providers-whatsapp-Dp8HfAry.js";
import { r as buildChannelConfigSchema } from "../../config-schema-BmvPUIYK.js";
import { a as chunkText } from "../../chunk-8IibRYUU.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-CI7vhbyR.js";
import { n as formatPairingApproveHint } from "../../helpers-PfWBHn-b.js";
import "../../text-runtime-DCigKjjg.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-DyrF9ISN.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-B9-JV7kL.js";
import { c as getChatChannelMeta } from "../../core-DYAvmXJF.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-D2rbMekf.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-D9CzvFBY.js";
import { t as resolveChannelMediaMaxBytes } from "../../media-limits-8sVS2ssI.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-C0n2CCnm.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-BpxzCz5l.js";
import { t as detectBinary } from "../../detect-binary-CTLvTjOw.js";
import "../../setup-tools-DVH8A_xE.js";
import "../../reply-runtime-CgdKC_bo.js";
import "../../media-runtime-B3sgGdPE.js";
import "../../channel-status-CGjVWC2r.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-BM0JCh4C.js";
import { d as looksLikeSignalTargetId, f as normalizeSignalMessagingTarget } from "../../identity-d3la2hxq.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-DlXKaj19.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-D8cVz10-.js";
import "../../config-api-CVJIS6ug.js";
import { r as installSignalCli } from "../../install-signal-cli-CWFw3Km3.js";
import { t as monitorSignalProvider } from "../../monitor-Ck7cHi-5.js";
import { t as sendMessageSignal } from "../../send-CHxhNAMu.js";
import { t as probeSignal } from "../../probe-DJ6mOFkU.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
