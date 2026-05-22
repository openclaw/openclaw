import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-gd9RYI9s.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-BQh-_Y7d.js";
import { c as getChatChannelMeta } from "../../core-BqKK0e13.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-Cyf2sWjo.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-0W8KVR3F.js";
import { t as chunkTextForOutbound } from "../../text-chunking-DYAKLfbn.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-BWpHs4Jo.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-DFnAP_vm.js";
import "../../channel-status-C--eIG63.js";
import { i as IMessageConfigSchema } from "../../bundled-channel-config-schema-C4yPoZ3d.js";
import { i as resolveIMessageAccount } from "../../accounts-C6d2k-OV.js";
import { t as probeIMessage } from "../../probe-cLySHS3U.js";
import { n as resolveIMessageGroupToolPolicy, r as imessageMessageActions, t as resolveIMessageGroupRequireMention } from "../../group-policy-uOLzSg4K.js";
import { o as looksLikeIMessageTargetId, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-MOHvhyqg.js";
import "../../config-api-B9H94dqR.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-Jy24isFo.js";
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
