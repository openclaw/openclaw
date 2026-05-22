import { t as formatCliCommand } from "../../command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "../../links-Dz4PCYCN.js";
import { l as normalizeE164 } from "../../utils-CpmNtyoq.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-CwBWagLE.js";
import { o as SignalConfigSchema } from "../../zod-schema.providers-whatsapp-Pankir6o.js";
import { r as buildChannelConfigSchema } from "../../config-schema-BovH0CJA.js";
import { a as chunkText } from "../../chunk-DZwoFz2Z.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-B6bqjWFY.js";
import { n as formatPairingApproveHint } from "../../helpers-BWKBbMq_.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-BlJnCW2V.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-BpCN1yCL.js";
import { c as getChatChannelMeta } from "../../core-CihBShbD.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-LLLxGXsu.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-9uFjq66r.js";
import { t as detectBinary } from "../../detect-binary-BjsMxAYK.js";
import "../../setup-tools-CMCdKh3Y.js";
import "../../reply-runtime-ByiaynP-.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-DeuscnM0.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-BFEMF3bx.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-tKw3qSeZ.js";
import "../../channel-status-DWmZgOx2.js";
import "../../text-utility-runtime-CTB88BtI.js";
import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-oW81rIlM.js";
import { d as normalizeSignalMessagingTarget, u as looksLikeSignalTargetId } from "../../identity-gYuWmq-u.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-Cts9WvGG.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-CEEZpBAa.js";
import "../../config-api-vY9UlJjL.js";
import { r as installSignalCli } from "../../install-signal-cli-C6UBVx4O.js";
import { t as monitorSignalProvider } from "../../monitor-DMLKCDao.js";
import { t as sendMessageSignal } from "../../send-BBefaVUr.js";
import { t as probeSignal } from "../../probe-LiKlVx9U.js";
//#region extensions/signal/src/runtime.ts
const { setRuntime: setSignalRuntime, clearRuntime: clearSignalRuntime } = createPluginRuntimeStore({
	pluginId: "signal",
	errorMessage: "Signal runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };
