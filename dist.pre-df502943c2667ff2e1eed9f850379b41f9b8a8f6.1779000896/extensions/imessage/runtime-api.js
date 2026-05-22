import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-N0fs4S4x.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-DW4DAoO6.js";
import { c as getChatChannelMeta } from "../../core-PZ9jJhPV.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-DpA2UZdL.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime--x8BthNJ.js";
import { t as chunkTextForOutbound } from "../../text-chunking-B_k4cuS8.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-DpXnmJCi.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-Cwggsbh4.js";
import "../../channel-status-CkID1ohH.js";
import { i as IMessageConfigSchema } from "../../bundled-channel-config-schema-DV8onDJE.js";
import { i as resolveIMessageAccount } from "../../accounts-42yf3FAy.js";
import { t as probeIMessage } from "../../probe-lokqjfED.js";
import { n as resolveIMessageGroupToolPolicy, r as imessageMessageActions, t as resolveIMessageGroupRequireMention } from "../../group-policy-DICDGapX.js";
import { o as looksLikeIMessageTargetId, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-BDPhRiC6.js";
import "../../config-api-DhnyRzJ3.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-Bt2QSFAN.js";
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
