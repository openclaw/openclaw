import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { i as IMessageConfigSchema } from "../../zod-schema.providers-whatsapp-CBTMFdxJ.js";
import { r as buildChannelConfigSchema } from "../../config-schema-BzjbZqXE.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-5BPKTW8P.js";
import { c as getChatChannelMeta } from "../../core-DrKqe3wh.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-D7S_cOrU.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-Dd0DSUkR.js";
import { t as chunkTextForOutbound } from "../../text-chunking-B9JYBWCq.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-DmHuSBT7.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-Csn-585_.js";
import "../../channel-status-O4BFybJX.js";
import { i as resolveIMessageAccount } from "../../accounts-BoSOxjRL.js";
import { t as probeIMessage } from "../../probe-BULMZFy2.js";
import { n as resolveIMessageGroupToolPolicy, r as imessageMessageActions, t as resolveIMessageGroupRequireMention } from "../../group-policy-BJdUKiVQ.js";
import { o as looksLikeIMessageTargetId, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-CUfentRJ.js";
import "../../config-api-DMx2uk7j.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-DnN9t5cW.js";
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
