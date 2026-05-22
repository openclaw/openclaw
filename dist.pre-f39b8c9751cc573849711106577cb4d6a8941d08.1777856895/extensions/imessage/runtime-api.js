import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-fkYplFFW.js";
import { r as buildChannelConfigSchema } from "../../config-schema-Cv6_wz1q.js";
import { i as IMessageConfigSchema } from "../../zod-schema.providers-whatsapp-BGYiCmAE.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-DAD0c7H8.js";
import { c as getChatChannelMeta } from "../../core-DJOjUZtD.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-zhyGrZKn.js";
import { t as resolveChannelMediaMaxBytes } from "../../media-limits-9HNm5nRX.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-CQAMfMKv.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-Bt2mvr5s.js";
import "../../media-runtime-BFyCHDx4.js";
import { t as chunkTextForOutbound } from "../../text-chunking-CBGjAx2u.js";
import "../../channel-status-C5TtpNEM.js";
import { s as resolveIMessageAccount } from "../../media-contract-CCAEV6xX.js";
import { f as looksLikeIMessageTargetId, p as normalizeIMessageMessagingTarget } from "../../conversation-id-DeqYw7n-.js";
import { n as resolveIMessageGroupToolPolicy, t as resolveIMessageGroupRequireMention } from "../../group-policy-DYZY5Jvz.js";
import "../../config-api-DcgkWdXb.js";
import { t as probeIMessage } from "../../probe-c9VnCvjk.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-Dv6y6skg.js";
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
