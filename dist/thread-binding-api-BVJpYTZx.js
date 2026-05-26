import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { a as resolveMatrixTargetIdentity } from "./target-ids-CPjRklwl.js";
//#region extensions/matrix/src/thread-binding-api.ts
const defaultTopLevelPlacement = "child";
function resolveMatrixInboundConversation(params) {
	const rawTarget = params.to?.trim() || params.conversationId?.trim() || "";
	const target = rawTarget ? resolveMatrixTargetIdentity(rawTarget) : null;
	const parentConversationId = target?.kind === "room" ? target.id : void 0;
	const threadId = params.threadId != null ? normalizeOptionalString(String(params.threadId)) : void 0;
	if (threadId) return {
		conversationId: threadId,
		...parentConversationId ? { parentConversationId } : {}
	};
	return parentConversationId ? { conversationId: parentConversationId } : null;
}
//#endregion
export { resolveMatrixInboundConversation as n, defaultTopLevelPlacement as t };
