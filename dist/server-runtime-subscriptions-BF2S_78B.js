import { l as onAgentEvent, t as clearAgentRunContext } from "./agent-events-CXxjiM_O.js";
import { n as onSessionTranscriptUpdate } from "./transcript-events-B00DLjg-.js";
import { n as onSessionLifecycleEvent } from "./session-lifecycle-events-Bvydm2oF.js";
import { r as onHeartbeatEvent } from "./heartbeat-events-Cs80gCmb.js";
//#region src/gateway/server-runtime-subscriptions.ts
function startGatewayEventSubscriptions(params) {
	let agentEventHandlerPromise = null;
	const getAgentEventHandler = () => {
		agentEventHandlerPromise ??= Promise.all([import("./server-chat-AuwSispm.js"), import("./server-session-key-C8PzilMx.js")]).then(([{ createAgentEventHandler }, { resolveSessionKeyForRun }]) => createAgentEventHandler({
			broadcast: params.broadcast,
			broadcastToConnIds: params.broadcastToConnIds,
			nodeSendToSession: params.nodeSendToSession,
			agentRunSeq: params.agentRunSeq,
			chatRunState: params.chatRunState,
			resolveSessionKeyForRun,
			clearAgentRunContext,
			toolEventRecipients: params.toolEventRecipients,
			sessionEventSubscribers: params.sessionEventSubscribers,
			isChatSendRunActive: (runId) => {
				const entry = params.chatAbortControllers.get(runId);
				return entry !== void 0 && entry.kind !== "agent";
			}
		}));
		return agentEventHandlerPromise;
	};
	let transcriptUpdateHandlerPromise = null;
	const getTranscriptUpdateHandler = () => {
		transcriptUpdateHandlerPromise ??= import("./server-session-events-DEorpnGv.js").then(({ createTranscriptUpdateBroadcastHandler }) => createTranscriptUpdateBroadcastHandler({
			broadcastToConnIds: params.broadcastToConnIds,
			sessionEventSubscribers: params.sessionEventSubscribers,
			sessionMessageSubscribers: params.sessionMessageSubscribers
		}));
		return transcriptUpdateHandlerPromise;
	};
	let lifecycleEventHandlerPromise = null;
	const getLifecycleEventHandler = () => {
		lifecycleEventHandlerPromise ??= import("./server-session-events-DEorpnGv.js").then(({ createLifecycleEventBroadcastHandler }) => createLifecycleEventBroadcastHandler({
			broadcastToConnIds: params.broadcastToConnIds,
			sessionEventSubscribers: params.sessionEventSubscribers
		}));
		return lifecycleEventHandlerPromise;
	};
	return {
		agentUnsub: onAgentEvent((evt) => {
			getAgentEventHandler().then((handler) => handler(evt));
		}),
		heartbeatUnsub: onHeartbeatEvent((evt) => {
			params.broadcast("heartbeat", evt, { dropIfSlow: true });
		}),
		transcriptUnsub: onSessionTranscriptUpdate((evt) => {
			getTranscriptUpdateHandler().then((handler) => handler(evt));
		}),
		lifecycleUnsub: onSessionLifecycleEvent((evt) => {
			getLifecycleEventHandler().then((handler) => handler(evt));
		})
	};
}
//#endregion
export { startGatewayEventSubscriptions };
