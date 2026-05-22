import { l as onAgentEvent, t as clearAgentRunContext } from "./agent-events-RrB1ssQj.js";
import { n as onSessionTranscriptUpdate } from "./transcript-events-RldKv4gA.js";
import { n as onSessionLifecycleEvent } from "./session-lifecycle-events-5dGa6Bji.js";
import { r as onHeartbeatEvent } from "./heartbeat-events-FK1YoDEq.js";
//#region src/gateway/server-runtime-subscriptions.ts
function startGatewayEventSubscriptions(params) {
	let agentEventHandlerPromise = null;
	const getAgentEventHandler = () => {
		agentEventHandlerPromise ??= Promise.all([import("./server-chat-odWYVXeP.js"), import("./server-session-key-CYm3bUF0.js")]).then(([{ createAgentEventHandler }, { resolveSessionKeyForRun }]) => createAgentEventHandler({
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
		transcriptUpdateHandlerPromise ??= import("./server-session-events-BejSFnk3.js").then(({ createTranscriptUpdateBroadcastHandler }) => createTranscriptUpdateBroadcastHandler({
			broadcastToConnIds: params.broadcastToConnIds,
			sessionEventSubscribers: params.sessionEventSubscribers,
			sessionMessageSubscribers: params.sessionMessageSubscribers
		}));
		return transcriptUpdateHandlerPromise;
	};
	let lifecycleEventHandlerPromise = null;
	const getLifecycleEventHandler = () => {
		lifecycleEventHandlerPromise ??= import("./server-session-events-BejSFnk3.js").then(({ createLifecycleEventBroadcastHandler }) => createLifecycleEventBroadcastHandler({
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
