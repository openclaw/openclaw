import { r as logVerbose } from "./globals-YU5FjfZK.js";
//#region src/auto-reply/reply/get-reply-run-queue.ts
const REPLY_RUN_STILL_SHUTTING_DOWN_TEXT = "⚠️ Previous run is still shutting down. Please try again in a moment.";
async function resolvePreparedReplyQueueState(params) {
	if (params.activeRunQueueAction !== "run-now" || !params.activeSessionId) return {
		kind: "continue",
		busyState: params.resolveBusyState()
	};
	if (params.queueMode === "interrupt") {
		const aborted = params.abortActiveRun(params.activeSessionId);
		logVerbose(`Interrupting active run for ${params.sessionKey ?? params.sessionId} (aborted=${aborted})`);
	}
	await params.waitForActiveRunEnd(params.activeSessionId);
	await params.refreshPreparedState();
	const refreshedBusyState = params.resolveBusyState();
	if (refreshedBusyState.isActive) return {
		kind: "reply",
		reply: { text: REPLY_RUN_STILL_SHUTTING_DOWN_TEXT }
	};
	return {
		kind: "continue",
		busyState: refreshedBusyState
	};
}
//#endregion
export { resolvePreparedReplyQueueState as n, REPLY_RUN_STILL_SHUTTING_DOWN_TEXT as t };
