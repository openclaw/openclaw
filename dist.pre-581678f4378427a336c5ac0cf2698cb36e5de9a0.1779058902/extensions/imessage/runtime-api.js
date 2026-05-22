import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DxANcyv3.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-CsphHypk.js";
import { c as getChatChannelMeta } from "../../core-BSbJPGGu.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-2ORR7yfg.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-BqjAMS-d.js";
import { t as chunkTextForOutbound } from "../../text-chunking-DZnxKaUJ.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-CjLaVP41.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-DoFEa01y.js";
import "../../channel-status-CoOBYmoa.js";
import { i as IMessageConfigSchema } from "../../bundled-channel-config-schema-vMxbl2Zb.js";
import { i as resolveIMessageAccount } from "../../accounts-DkMLLg3N.js";
import { t as probeIMessage } from "../../probe-DFPHRZce.js";
import { n as resolveIMessageGroupToolPolicy, r as imessageMessageActions, t as resolveIMessageGroupRequireMention } from "../../group-policy-B1eistj1.js";
import { o as looksLikeIMessageTargetId, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-Cj8Ipb1N.js";
import "../../config-api-DZuSJD_N.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-CxfkXd9H.js";
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
