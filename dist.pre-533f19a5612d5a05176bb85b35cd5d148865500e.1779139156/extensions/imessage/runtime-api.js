import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-gd9RYI9s.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-BQh-_Y7d.js";
import { c as getChatChannelMeta } from "../../core-DFuaL5sM.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-BPbfSxdB.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-C_YRRJZQ.js";
import { t as chunkTextForOutbound } from "../../text-chunking-CQ6uz2HY.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-B6vSZJO3.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-CL121ZpD.js";
import "../../channel-status-C1bs_3mh.js";
import { i as IMessageConfigSchema } from "../../bundled-channel-config-schema-CaAok3C8.js";
import { i as resolveIMessageAccount } from "../../accounts-BgTRjeUK.js";
import { t as probeIMessage } from "../../probe-BIjGcDpE.js";
import { n as resolveIMessageGroupToolPolicy, r as imessageMessageActions, t as resolveIMessageGroupRequireMention } from "../../group-policy-CDCvkcqm.js";
import { o as looksLikeIMessageTargetId, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-zim1SJs3.js";
import "../../config-api-mdn7yNQ9.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-DsI0006y.js";
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
