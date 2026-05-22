import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-DUpVOe8L.js";
import { r as buildChannelConfigSchema } from "../../config-schema-C2n-k4o1.js";
import { i as IMessageConfigSchema } from "../../zod-schema.providers-whatsapp-BGDCDnty.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-PRwm72zi.js";
import { c as getChatChannelMeta } from "../../core-C4iiEmAV.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-BToSvHpc.js";
import { t as resolveChannelMediaMaxBytes } from "../../media-limits-D0rXBd6e.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-B7fZ2qTh.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-BvzPNo7p.js";
import "../../media-runtime-5rxXL-Os.js";
import { t as chunkTextForOutbound } from "../../text-chunking-CMSV2261.js";
import "../../channel-status-be0NZxcV.js";
import { s as resolveIMessageAccount } from "../../media-contract-B1itZUnm.js";
import { f as looksLikeIMessageTargetId, p as normalizeIMessageMessagingTarget } from "../../conversation-id-BUAx7ZbF.js";
import { n as resolveIMessageGroupToolPolicy, t as resolveIMessageGroupRequireMention } from "../../group-policy-_6r9QM-a.js";
import "../../config-api-BKQ08ofC.js";
import { t as probeIMessage } from "../../probe-BIhRpoPU.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-DPCYWITy.js";
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
export { DEFAULT_ACCOUNT_ID, IMessageConfigSchema, PAIRING_APPROVED_MESSAGE, buildChannelConfigSchema, buildComputedAccountStatusSnapshot, chunkTextForOutbound, collectStatusIssuesFromLastError, formatTrimmedAllowFromEntries, getChatChannelMeta, looksLikeIMessageTargetId, monitorIMessageProvider, normalizeIMessageMessagingTarget, probeIMessage, resolveChannelMediaMaxBytes, resolveIMessageConfigAllowFrom, resolveIMessageConfigDefaultTo, resolveIMessageGroupRequireMention, resolveIMessageGroupToolPolicy, sendMessageIMessage, setIMessageRuntime };
