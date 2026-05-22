import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { i as IMessageConfigSchema } from "../../zod-schema.providers-whatsapp-C5Cf1lvs.js";
import { r as buildChannelConfigSchema } from "../../config-schema-RuhSQMup.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-BOaIkSuX.js";
import { c as getChatChannelMeta } from "../../core-DCSJmjRQ.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-C20iH_sr.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-Bkhg9eNT.js";
import { t as chunkTextForOutbound } from "../../text-chunking-CkhUMyQF.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-BeaXTGbH.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-CMJ5OzbS.js";
import "../../channel-status-Dj8mUppJ.js";
import { i as resolveIMessageAccount } from "../../accounts-DN_r6gBi.js";
import { t as probeIMessage } from "../../probe-BMRGMSNf.js";
import { n as resolveIMessageGroupToolPolicy, r as imessageMessageActions, t as resolveIMessageGroupRequireMention } from "../../group-policy-B-1Ue6Rr.js";
import { o as looksLikeIMessageTargetId, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-QBFpXBkg.js";
import "../../config-api-HTyztmgc.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-LPwV-im3.js";
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
