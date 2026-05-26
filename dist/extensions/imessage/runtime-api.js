import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-B32J-iNN.js";
import { r as buildChannelConfigSchema } from "../../config-schema-ChfiQrSg.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-xZ4-bv2H.js";
import { c as getChatChannelMeta } from "../../core-kXuNbs5U.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-Cezm5nT2.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-BheBFFxc.js";
import { t as chunkTextForOutbound } from "../../text-chunking-C154U6-i.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-C9w9gv4K.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-CnvYAK73.js";
import "../../channel-status-pVVcmlap.js";
import { i as IMessageConfigSchema } from "../../bundled-channel-config-schema-CA36mrPs.js";
import { i as resolveIMessageAccount } from "../../accounts-G6A_hywc.js";
import { t as probeIMessage } from "../../probe-DlyCigli.js";
import { n as resolveIMessageGroupToolPolicy, r as imessageMessageActions, t as resolveIMessageGroupRequireMention } from "../../group-policy-D47qAdAl.js";
import { o as looksLikeIMessageTargetId, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-BQ1rwkeO.js";
import "../../config-api-BwW6j7nL.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-CPg00T5t.js";
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
