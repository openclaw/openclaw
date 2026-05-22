import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { i as IMessageConfigSchema } from "../../zod-schema.providers-whatsapp-CKJdvmco.js";
import { r as buildChannelConfigSchema } from "../../config-schema-bYjGMbfy.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-BmQQzD3f.js";
import { c as getChatChannelMeta } from "../../core-DJqj23Pm.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-OWAYvd1I.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-DZ1nM-JH.js";
import { t as chunkTextForOutbound } from "../../text-chunking-Dd4mHdk2.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-Uouqymoo.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-Dzp0y1UL.js";
import "../../channel-status-v0vCi1Fh.js";
import { i as resolveIMessageAccount } from "../../accounts-Blkg1ybi.js";
import { t as probeIMessage } from "../../probe-DUMAAtAM.js";
import { n as resolveIMessageGroupToolPolicy, r as imessageMessageActions, t as resolveIMessageGroupRequireMention } from "../../group-policy-DE_r1PDX.js";
import { o as looksLikeIMessageTargetId, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-3gxLXJcx.js";
import "../../config-api-CS23mZy6.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-zxgWhsDc.js";
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
