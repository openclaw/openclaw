import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-CwBWagLE.js";
import { i as IMessageConfigSchema } from "../../zod-schema.providers-whatsapp-Pankir6o.js";
import { r as buildChannelConfigSchema } from "../../config-schema-BovH0CJA.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-DEa-Ib2y.js";
import { c as getChatChannelMeta } from "../../core-CihBShbD.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-LLLxGXsu.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-DeuscnM0.js";
import { t as chunkTextForOutbound } from "../../text-chunking-WnXdOF_7.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-BFEMF3bx.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-tKw3qSeZ.js";
import "../../channel-status-DWmZgOx2.js";
import { i as resolveIMessageAccount } from "../../accounts-DmTizkpl.js";
import { t as probeIMessage } from "../../probe-w_1hOhwM.js";
import { n as resolveIMessageGroupToolPolicy, r as imessageMessageActions, t as resolveIMessageGroupRequireMention } from "../../group-policy-DWXfuYq0.js";
import { o as looksLikeIMessageTargetId, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-K3Wcqc16.js";
import "../../config-api-0iubJ5H_.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-Bp1vFqua.js";
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
