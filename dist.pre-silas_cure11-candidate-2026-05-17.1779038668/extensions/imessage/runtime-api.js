import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-N0fs4S4x.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-DWm_E9mv.js";
import { c as getChatChannelMeta } from "../../core-DlOTX_kM.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-DUe79kGC.js";
import { a as resolveChannelMediaMaxBytes } from "../../media-runtime-Cu1-Pffz.js";
import { t as chunkTextForOutbound } from "../../text-chunking-BdRhujLD.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-W_ywCxLU.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-zPU2wFDW.js";
import "../../channel-status-Bf1Fg2Mi.js";
import { i as IMessageConfigSchema } from "../../bundled-channel-config-schema-BZx-IoDt.js";
import { i as resolveIMessageAccount } from "../../accounts-BghUWzew.js";
import { t as probeIMessage } from "../../probe-CkMWJ2TW.js";
import { n as resolveIMessageGroupToolPolicy, r as imessageMessageActions, t as resolveIMessageGroupRequireMention } from "../../group-policy-MgykelFI.js";
import { o as looksLikeIMessageTargetId, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-CJfxyGaT.js";
import "../../config-api-C9j3ohFc.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-vFDtc2nP.js";
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
