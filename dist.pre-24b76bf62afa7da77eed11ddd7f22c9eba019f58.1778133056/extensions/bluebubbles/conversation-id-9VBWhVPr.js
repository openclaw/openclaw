import { O as normalizeBlueBubblesHandle, S as extractHandleFromChatGuid, j as parseBlueBubblesTarget } from "./probe-95uA8cJS.js";
//#region extensions/bluebubbles/src/conversation-id.ts
function normalizeBlueBubblesAcpConversationId(conversationId) {
	const trimmed = conversationId.trim();
	if (!trimmed) return null;
	try {
		const parsed = parseBlueBubblesTarget(trimmed);
		if (parsed.kind === "handle") {
			const handle = normalizeBlueBubblesHandle(parsed.to);
			return handle ? { conversationId: handle } : null;
		}
		if (parsed.kind === "chat_id") return { conversationId: String(parsed.chatId) };
		if (parsed.kind === "chat_guid") return { conversationId: extractHandleFromChatGuid(parsed.chatGuid) || parsed.chatGuid };
		return { conversationId: parsed.chatIdentifier };
	} catch {
		const handle = normalizeBlueBubblesHandle(trimmed);
		return handle ? { conversationId: handle } : null;
	}
}
function matchBlueBubblesAcpConversation(params) {
	const binding = normalizeBlueBubblesAcpConversationId(params.bindingConversationId);
	const conversation = normalizeBlueBubblesAcpConversationId(params.conversationId);
	if (!binding || !conversation) return null;
	if (binding.conversationId !== conversation.conversationId) return null;
	return {
		conversationId: conversation.conversationId,
		matchPriority: 2
	};
}
function resolveBlueBubblesInboundConversationId(params) {
	if (!params.isGroup) return normalizeBlueBubblesHandle(params.sender) || void 0;
	return params.chatGuid && normalizeBlueBubblesAcpConversationId(params.chatGuid)?.conversationId || params.chatIdentifier && normalizeBlueBubblesAcpConversationId(params.chatIdentifier)?.conversationId || (params.chatId != null && Number.isFinite(params.chatId) ? String(params.chatId) : "") || void 0;
}
function resolveBlueBubblesConversationIdFromTarget(target) {
	return normalizeBlueBubblesAcpConversationId(target)?.conversationId;
}
//#endregion
export { resolveBlueBubblesInboundConversationId as i, normalizeBlueBubblesAcpConversationId as n, resolveBlueBubblesConversationIdFromTarget as r, matchBlueBubblesAcpConversation as t };
