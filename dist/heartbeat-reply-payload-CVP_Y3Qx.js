import { s as hasOutboundReplyContent } from "./reply-payload-DMPQsrQC.js";
//#region src/auto-reply/heartbeat-reply-payload.ts
function resolveHeartbeatReplyPayload(replyResult) {
	if (!replyResult) return;
	if (!Array.isArray(replyResult)) return replyResult;
	for (let idx = replyResult.length - 1; idx >= 0; idx -= 1) {
		const payload = replyResult[idx];
		if (!payload) continue;
		if (hasOutboundReplyContent(payload)) return payload;
	}
}
//#endregion
export { resolveHeartbeatReplyPayload as t };
