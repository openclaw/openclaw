import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-CwBWagLE.js";
import { i as IMessageConfigSchema } from "../../zod-schema.providers-whatsapp-BElo3xB4.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DftNRjDz.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-Dzal6cfS.js";
import { c as getChatChannelMeta } from "../../core-BPnS_bab.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-Cigg_Veg.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-DWh6m_8p.js";
import { t as chunkTextForOutbound } from "../../text-chunking-3_9rfiI8.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-C5_Dm1pD.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-Dk-3BT6p.js";
import "../../channel-status-DQzE7laT.js";
import { i as resolveIMessageAccount } from "../../accounts-DwISomWw.js";
import { t as probeIMessage } from "../../probe-4JZGtekU.js";
import { n as resolveIMessageGroupToolPolicy, r as imessageMessageActions, t as resolveIMessageGroupRequireMention } from "../../group-policy-DWbsvBO9.js";
import { o as looksLikeIMessageTargetId, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-B-2kV4-Q.js";
import "../../config-api-fK3CRNuq.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-B9UQDKCF.js";
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
export { DEFAULT_ACCOUNT_ID, IMessageConfigSchema, PAIRING_APPROVED_MESSAGE, buildChannelConfigSchema, buildComputedAccountStatusSnapshot, chunkTextForOutbound, collectStatusIssuesFromLastError, formatTrimmedAllowFromEntries, getChatChannelMeta, imessageMessageActions, looksLikeIMessageTargetId, monitorIMessageProvider, normalizeIMessageMessagingTarget, probeIMessage, resolveChannelMediaMaxBytes, resolveIMessageConfigAllowFrom, resolveIMessageConfigDefaultTo, resolveIMessageGroupRequireMention, resolveIMessageGroupToolPolicy, sendMessageIMessage, setIMessageRuntime };
