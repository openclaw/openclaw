import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-gd9RYI9s.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-BV5fnOX9.js";
import { c as getChatChannelMeta } from "../../core-9GmaT57C.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-Ck0e4Li2.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-CsDiyKfD.js";
import { t as chunkTextForOutbound } from "../../text-chunking-BG62trjr.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-Jq5bmS3N.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-DC20QesH.js";
import "../../channel-status-DsH1v7Er.js";
import { i as IMessageConfigSchema } from "../../bundled-channel-config-schema-DI3MKmEu.js";
import { i as resolveIMessageAccount } from "../../accounts-C3IXhlVj.js";
import { t as probeIMessage } from "../../probe-DNGdAf7o.js";
import { n as resolveIMessageGroupToolPolicy, r as imessageMessageActions, t as resolveIMessageGroupRequireMention } from "../../group-policy-CT-JV51k.js";
import { o as looksLikeIMessageTargetId, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-DmN7YLtB.js";
import "../../config-api-C9a7OtCU.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-7AyxZTlF.js";
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
