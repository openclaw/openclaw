import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-Bj7l9NI7.js";
import { i as IMessageConfigSchema } from "../../zod-schema.providers-whatsapp-CSUEJ-NX.js";
import { r as buildChannelConfigSchema } from "../../config-schema-DZSQT0EH.js";
import { p as formatTrimmedAllowFromEntries } from "../../channel-config-helpers-D37zitas.js";
import { c as getChatChannelMeta } from "../../core-B2c9_N7p.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-67Vxx2iX.js";
import { t as resolveChannelMediaMaxBytes } from "../../media-limits-DkpcBnqF.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-CluH3mwm.js";
import { c as collectStatusIssuesFromLastError, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-ml9CygpH.js";
import "../../media-runtime-Doi16sSJ.js";
import { t as chunkTextForOutbound } from "../../text-chunking-BMoWAm7A.js";
import "../../channel-status-D_w9jtCo.js";
import { s as resolveIMessageAccount } from "../../media-contract-BR5ovOC4.js";
import { f as looksLikeIMessageTargetId, p as normalizeIMessageMessagingTarget } from "../../conversation-id-CJe3p45Y.js";
import { n as resolveIMessageGroupToolPolicy, t as resolveIMessageGroupRequireMention } from "../../group-policy-CR3HDYvh.js";
import "../../config-api-D9C7Pg9G.js";
import { t as probeIMessage } from "../../probe-C-ThcJWW.js";
import { n as sendMessageIMessage, t as monitorIMessageProvider } from "../../monitor-CnuM0GS5.js";
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
