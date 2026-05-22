import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { i as IMessageConfigSchema } from "../../zod-schema.providers-whatsapp-DgRFv5mw.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DJNyYIkR.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-B4oQiCpN.js";
import { c as getChatChannelMeta } from "../../core-CQ0EhoHb.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-Gsztj7De.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-VIdlgue-.js";
import { t as chunkTextForOutbound } from "../../text-chunking-Bk1M0NOo.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-DJUA4wt9.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-DUEfpOKW.js";
import "../../channel-status-BOptdune.js";
import { i as resolveIMessageAccount } from "../../accounts-DEXf2tW-.js";
import { t as probeIMessage } from "../../probe-Di4v8Ddx.js";
import { n as resolveIMessageGroupToolPolicy, r as imessageMessageActions, t as resolveIMessageGroupRequireMention } from "../../group-policy-CmS-j_Zy.js";
import { o as looksLikeIMessageTargetId, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-BuG8OCiA.js";
import "../../config-api-DqYjfU_d.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-Cs5hPMLU.js";
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
