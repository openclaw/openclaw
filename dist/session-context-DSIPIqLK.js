import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { _ as resolveSessionAgentId } from "./agent-scope-CtLXGcWm.js";
import { t as normalizeChatType } from "./chat-type-D_QPUzR1.js";
//#region src/infra/outbound/session-context.ts
function buildOutboundSessionContext(params) {
	const key = normalizeOptionalString(params.sessionKey);
	const policyKey = normalizeOptionalString(params.policySessionKey);
	const normalizedChatType = normalizeChatType(params.conversationType ?? void 0);
	const conversationType = normalizedChatType === "group" || normalizedChatType === "channel" ? "group" : normalizedChatType === "direct" ? "direct" : params.isGroup === true ? "group" : params.isGroup === false ? "direct" : void 0;
	const explicitAgentId = normalizeOptionalString(params.agentId);
	const requesterAccountId = normalizeOptionalString(params.requesterAccountId);
	const requesterSenderId = normalizeOptionalString(params.requesterSenderId);
	const requesterSenderName = normalizeOptionalString(params.requesterSenderName);
	const requesterSenderUsername = normalizeOptionalString(params.requesterSenderUsername);
	const requesterSenderE164 = normalizeOptionalString(params.requesterSenderE164);
	const derivedAgentId = key ? resolveSessionAgentId({
		sessionKey: key,
		config: params.cfg
	}) : void 0;
	const agentId = explicitAgentId ?? derivedAgentId;
	if (!key && !policyKey && !conversationType && !agentId && !requesterAccountId && !requesterSenderId && !requesterSenderName && !requesterSenderUsername && !requesterSenderE164) return;
	return {
		...key ? { key } : {},
		...policyKey ? { policyKey } : {},
		...conversationType ? { conversationType } : {},
		...agentId ? { agentId } : {},
		...requesterAccountId ? { requesterAccountId } : {},
		...requesterSenderId ? { requesterSenderId } : {},
		...requesterSenderName ? { requesterSenderName } : {},
		...requesterSenderUsername ? { requesterSenderUsername } : {},
		...requesterSenderE164 ? { requesterSenderE164 } : {}
	};
}
//#endregion
export { buildOutboundSessionContext as t };
