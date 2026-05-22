import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-B32J-iNN.js";
import { r as buildChannelConfigSchema } from "../../config-schema-CyiAUc5R.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-xZ4-bv2H.js";
import { c as getChatChannelMeta } from "../../core-DxJG0skC.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-Cezm5nT2.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-C5IoNmJM.js";
import { t as chunkTextForOutbound } from "../../text-chunking-B1eCf5mf.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-C9w9gv4K.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-C5mDIh9J.js";
import "../../channel-status-pmRGSI7K.js";
import { i as IMessageConfigSchema } from "../../bundled-channel-config-schema-ThEmc3Nk.js";
import { i as resolveIMessageAccount } from "../../accounts-s9sFXzCz.js";
import { t as probeIMessage } from "../../probe-Cm7ZQijh.js";
import { n as resolveIMessageGroupToolPolicy, r as imessageMessageActions, t as resolveIMessageGroupRequireMention } from "../../group-policy-tpMOFS-1.js";
import { o as looksLikeIMessageTargetId, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-Dp5uZeqd.js";
import "../../config-api-Dzc6QYYh.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-0bX8Vy2D.js";
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
