import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { i as IMessageConfigSchema } from "../../zod-schema.providers-whatsapp-Chk998Rz.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DYzVFvFQ.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-Dd68-pWO.js";
import { c as getChatChannelMeta } from "../../core-X81hhXAW.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-BY975gH9.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-BzgZghzj.js";
import { t as chunkTextForOutbound } from "../../text-chunking-r-W0vXo8.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-C5_Dm1pD.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-EU2hrlO2.js";
import "../../channel-status-B1B6b1FE.js";
import { i as resolveIMessageAccount } from "../../accounts-BFkFFafL.js";
import { t as probeIMessage } from "../../probe-C5sGi2TG.js";
import { n as resolveIMessageGroupToolPolicy, r as imessageMessageActions, t as resolveIMessageGroupRequireMention } from "../../group-policy-CYF7tHp2.js";
import { o as looksLikeIMessageTargetId, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-CTXWwDdw.js";
import "../../config-api-un0bfbyg.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-UFh2ahdh.js";
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
