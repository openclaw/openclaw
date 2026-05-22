import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { i as IMessageConfigSchema } from "../../zod-schema.providers-whatsapp-Chk998Rz.js";
import { r as buildChannelConfigSchema } from "../../config-schema-B1ZkUpkb.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-C5msK1mQ.js";
import { c as getChatChannelMeta } from "../../core-DgePbJ7i.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-Cg9cOb9V.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-DMdnxXjU.js";
import { t as chunkTextForOutbound } from "../../text-chunking-CJtMnG6C.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-rhC4efse.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-D6qvq3Fy.js";
import "../../channel-status-DqKjqAvf.js";
import { i as resolveIMessageAccount } from "../../accounts-CszruQH0.js";
import { t as probeIMessage } from "../../probe-l6igR5M4.js";
import { n as resolveIMessageGroupToolPolicy, r as imessageMessageActions, t as resolveIMessageGroupRequireMention } from "../../group-policy-BqMkmS1r.js";
import { o as looksLikeIMessageTargetId, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-ChE2TBzr.js";
import "../../config-api-BIQZjqzw.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-BbhWV_qI.js";
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
