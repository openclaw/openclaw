import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-Bte5Yg6T.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-caI9TN6H.js";
import { c as getChatChannelMeta } from "../../core-D6GRGQLE.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-CSfjApnh.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime--1rTkfXw.js";
import { t as chunkTextForOutbound } from "../../text-chunking-DjlMd8vL.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-DAZut6Hh.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-MWz4ebYh.js";
import "../../channel-status-D8Np2Hnc.js";
import { i as IMessageConfigSchema } from "../../bundled-channel-config-schema-CwSmAESn.js";
import { i as resolveIMessageAccount } from "../../accounts-C0NOut5D.js";
import { t as probeIMessage } from "../../probe-QDPTAO8k.js";
import { n as resolveIMessageGroupToolPolicy, r as imessageMessageActions, t as resolveIMessageGroupRequireMention } from "../../group-policy-BNWU6lGL.js";
import { o as looksLikeIMessageTargetId, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-DjLsRj01.js";
import "../../config-api-Dkc_lB44.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-DAAfRsFI.js";
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
