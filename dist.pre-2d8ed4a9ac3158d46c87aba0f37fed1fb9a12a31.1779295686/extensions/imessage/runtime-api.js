import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DfoOcZXb.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-DzU-bs8l.js";
import { c as getChatChannelMeta } from "../../core-Cuiiy1ZS.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-MAmQRWGj.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-B14sZn5Z.js";
import { t as chunkTextForOutbound } from "../../text-chunking-B1yt63di.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-BLG_q0yv.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-Csewe3pX.js";
import "../../channel-status-BrGRj_08.js";
import { i as IMessageConfigSchema } from "../../bundled-channel-config-schema-BcAkK-Ic.js";
import { i as resolveIMessageAccount } from "../../accounts-olsq2zPB.js";
import { t as probeIMessage } from "../../probe-CrqXzlvm.js";
import { n as resolveIMessageGroupToolPolicy, r as imessageMessageActions, t as resolveIMessageGroupRequireMention } from "../../group-policy-D_YES9VM.js";
import { o as looksLikeIMessageTargetId, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-C-hauJvG.js";
import "../../config-api-B-DARND8.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-BEePWx9M.js";
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
