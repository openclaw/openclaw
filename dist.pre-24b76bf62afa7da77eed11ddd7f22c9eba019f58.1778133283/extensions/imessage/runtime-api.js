import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-Bj7l9NI7.js";
import { i as IMessageConfigSchema } from "../../zod-schema.providers-whatsapp-Dp8HfAry.js";
import { r as buildChannelConfigSchema } from "../../config-schema-BmvPUIYK.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-DA-YZSMa.js";
import { c as getChatChannelMeta } from "../../core-DYAvmXJF.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-D2rbMekf.js";
import { t as resolveChannelMediaMaxBytes } from "../../media-limits-8sVS2ssI.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-C0n2CCnm.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-BpxzCz5l.js";
import "../../media-runtime-B3sgGdPE.js";
import { t as chunkTextForOutbound } from "../../text-chunking-uHaxHBm6.js";
import "../../channel-status-CGjVWC2r.js";
import { s as resolveIMessageAccount } from "../../media-contract-DLrXQ0zX.js";
import { f as looksLikeIMessageTargetId, p as normalizeIMessageMessagingTarget } from "../../conversation-id-DTDTBN3Z.js";
import { n as resolveIMessageGroupToolPolicy, t as resolveIMessageGroupRequireMention } from "../../group-policy-D1B_ocZS.js";
import "../../config-api-DNpuC9Qk.js";
import { t as probeIMessage } from "../../probe-szO3leT0.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-BePiwR1C.js";
//#region extensions/imessage/src/config-accessors.ts
function resolveIMessageConfigAllowFrom(params) {
	return (resolveIMessageAccount(params).config.allowFrom ?? []).map((entry) => String(entry));
}
function resolveIMessageConfigDefaultTo(params) {
	const defaultTo = resolveIMessageAccount(params).config.defaultTo;
	if (defaultTo == null) return;
	return defaultTo.trim() || void 0;
}
//#endregion
//#region extensions/imessage/src/runtime.ts
const { setRuntime: setIMessageRuntime } = createPluginRuntimeStore({
	pluginId: "imessage",
	errorMessage: "iMessage runtime not initialized"
});
//#endregion
export { DEFAULT_ACCOUNT_ID, IMessageConfigSchema, PAIRING_APPROVED_MESSAGE, buildChannelConfigSchema, buildComputedAccountStatusSnapshot, chunkTextForOutbound, collectStatusIssuesFromLastError, formatTrimmedAllowFromEntries, getChatChannelMeta, looksLikeIMessageTargetId, monitorIMessageProvider, normalizeIMessageMessagingTarget, probeIMessage, resolveChannelMediaMaxBytes, resolveIMessageConfigAllowFrom, resolveIMessageConfigDefaultTo, resolveIMessageGroupRequireMention, resolveIMessageGroupToolPolicy, sendMessageIMessage, setIMessageRuntime };
