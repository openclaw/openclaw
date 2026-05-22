import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-gd9RYI9s.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-BV5fnOX9.js";
import { c as getChatChannelMeta } from "../../core-DfXPRYzR.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-Ck0e4Li2.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-eri84b_Q.js";
import { t as chunkTextForOutbound } from "../../text-chunking-CfgOiEjf.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-5hyKIuvT.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-BunFlW3J.js";
import "../../channel-status-DYYgC8Iv.js";
import { i as IMessageConfigSchema } from "../../bundled-channel-config-schema-DKky0-Dd.js";
import { i as resolveIMessageAccount } from "../../accounts-CsoRklLc.js";
import { t as probeIMessage } from "../../probe-BOwFG3bF.js";
import { n as resolveIMessageGroupToolPolicy, r as imessageMessageActions, t as resolveIMessageGroupRequireMention } from "../../group-policy-B4qYF-Ym.js";
import { o as looksLikeIMessageTargetId, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-B9fVMSa-.js";
import "../../config-api-CUMZR9WH.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-AWHytxQG.js";
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
