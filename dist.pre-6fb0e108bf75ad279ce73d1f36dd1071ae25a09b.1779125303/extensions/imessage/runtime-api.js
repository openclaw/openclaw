import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-gd9RYI9s.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-BV5fnOX9.js";
import { c as getChatChannelMeta } from "../../core-BeACHtvF.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-Ck0e4Li2.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-CTGr8VtE.js";
import { t as chunkTextForOutbound } from "../../text-chunking-CfgOiEjf.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-BssVwtlc.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-DYX6v68d.js";
import "../../channel-status-DmDLldrU.js";
import { i as IMessageConfigSchema } from "../../bundled-channel-config-schema-CR_47WNy.js";
import { i as resolveIMessageAccount } from "../../accounts-BAYdJbRB.js";
import { t as probeIMessage } from "../../probe-Cv_8UwWj.js";
import { n as resolveIMessageGroupToolPolicy, r as imessageMessageActions, t as resolveIMessageGroupRequireMention } from "../../group-policy-CL16lxZv.js";
import { o as looksLikeIMessageTargetId, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-DPoPx7Ig.js";
import "../../config-api-B-WzIqUy.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-BfjKRfG5.js";
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
