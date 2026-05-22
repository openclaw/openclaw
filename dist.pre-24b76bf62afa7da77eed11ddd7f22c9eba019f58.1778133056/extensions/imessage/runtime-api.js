import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-05Z3mmpO.js";
import { i as IMessageConfigSchema } from "../../zod-schema.providers-whatsapp-B8jvaNbU.js";
import { r as buildChannelConfigSchema } from "../../config-schema-CLM6ogpT.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-LfEE_4Xc.js";
import { c as getChatChannelMeta } from "../../core-BsEhQ_g7.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-Wij_b93b.js";
import { t as resolveChannelMediaMaxBytes } from "../../media-limits-LwaYNoUx.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-DDuxp0PB.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-CaAM_77P.js";
import "../../media-runtime-CfGiZyk2.js";
import { t as chunkTextForOutbound } from "../../text-chunking-BceJUYd2.js";
import "../../channel-status-Bs_3DYkc.js";
import { s as resolveIMessageAccount } from "../../media-contract-BwZTTinB.js";
import { f as looksLikeIMessageTargetId, p as normalizeIMessageMessagingTarget } from "../../conversation-id-D0aSLdBC.js";
import { n as resolveIMessageGroupToolPolicy, t as resolveIMessageGroupRequireMention } from "../../group-policy-DaEIVHkJ.js";
import "../../config-api-D6rDGuAS.js";
import { t as probeIMessage } from "../../probe-DdrORlaW.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-Ccmf_nPO.js";
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
