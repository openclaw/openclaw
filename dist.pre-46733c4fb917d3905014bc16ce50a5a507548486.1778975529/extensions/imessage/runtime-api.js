import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-BvWy-UYr.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-D_ZmBZUK.js";
import { c as getChatChannelMeta } from "../../core-D3B0oqI3.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-CSfjApnh.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-B6CavSZQ.js";
import { t as chunkTextForOutbound } from "../../text-chunking-BDDPJPB6.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-Btn1csDe.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-Drvd6qXd.js";
import "../../channel-status-7KUVffLE.js";
import { i as IMessageConfigSchema } from "../../bundled-channel-config-schema-CTX_dhcp.js";
import { i as resolveIMessageAccount } from "../../accounts-Db15EMtH.js";
import { t as probeIMessage } from "../../probe-IGTqXxBG.js";
import { n as resolveIMessageGroupToolPolicy, r as imessageMessageActions, t as resolveIMessageGroupRequireMention } from "../../group-policy-DiqkQNon.js";
import { o as looksLikeIMessageTargetId, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-Bcb9NRxk.js";
import "../../config-api-CLdpd5y5.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-B7oYs-Uh.js";
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
