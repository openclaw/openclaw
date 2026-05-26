import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { n as serializeEventPayload, t as NodeRegistry } from "./node-registry-BBkeim70.js";
import { i as createSessionMessageSubscriberRegistry, r as createSessionEventSubscriberRegistry } from "./server-chat-state-5p6_r5uT.js";
//#region src/gateway/server-node-subscriptions.ts
function createNodeSubscriptionManager() {
	const nodeSubscriptions = /* @__PURE__ */ new Map();
	const sessionSubscribers = /* @__PURE__ */ new Map();
	const toPayloadJSON = (payload) => serializeEventPayload(payload);
	const subscribe = (nodeId, sessionKey) => {
		const normalizedNodeId = nodeId.trim();
		const normalizedSessionKey = sessionKey.trim();
		if (!normalizedNodeId || !normalizedSessionKey) return;
		let nodeSet = nodeSubscriptions.get(normalizedNodeId);
		if (!nodeSet) {
			nodeSet = /* @__PURE__ */ new Set();
			nodeSubscriptions.set(normalizedNodeId, nodeSet);
		}
		if (nodeSet.has(normalizedSessionKey)) return;
		nodeSet.add(normalizedSessionKey);
		let sessionSet = sessionSubscribers.get(normalizedSessionKey);
		if (!sessionSet) {
			sessionSet = /* @__PURE__ */ new Set();
			sessionSubscribers.set(normalizedSessionKey, sessionSet);
		}
		sessionSet.add(normalizedNodeId);
	};
	const unsubscribe = (nodeId, sessionKey) => {
		const normalizedNodeId = nodeId.trim();
		const normalizedSessionKey = sessionKey.trim();
		if (!normalizedNodeId || !normalizedSessionKey) return;
		const nodeSet = nodeSubscriptions.get(normalizedNodeId);
		nodeSet?.delete(normalizedSessionKey);
		if (nodeSet?.size === 0) nodeSubscriptions.delete(normalizedNodeId);
		const sessionSet = sessionSubscribers.get(normalizedSessionKey);
		sessionSet?.delete(normalizedNodeId);
		if (sessionSet?.size === 0) sessionSubscribers.delete(normalizedSessionKey);
	};
	const unsubscribeAll = (nodeId) => {
		const normalizedNodeId = nodeId.trim();
		const nodeSet = nodeSubscriptions.get(normalizedNodeId);
		if (!nodeSet) return;
		for (const sessionKey of nodeSet) {
			const sessionSet = sessionSubscribers.get(sessionKey);
			sessionSet?.delete(normalizedNodeId);
			if (sessionSet?.size === 0) sessionSubscribers.delete(sessionKey);
		}
		nodeSubscriptions.delete(normalizedNodeId);
	};
	const sendToSession = (sessionKey, event, payload, sendEvent) => {
		const normalizedSessionKey = sessionKey.trim();
		if (!normalizedSessionKey || !sendEvent) return;
		const subs = sessionSubscribers.get(normalizedSessionKey);
		if (!subs || subs.size === 0) return;
		const payloadJSON = toPayloadJSON(payload);
		for (const nodeId of subs) sendEvent({
			nodeId,
			event,
			payloadJSON
		});
	};
	const sendToAllSubscribed = (event, payload, sendEvent) => {
		if (!sendEvent) return;
		const payloadJSON = toPayloadJSON(payload);
		for (const nodeId of nodeSubscriptions.keys()) sendEvent({
			nodeId,
			event,
			payloadJSON
		});
	};
	const sendToAllConnected = (event, payload, listConnected, sendEvent) => {
		if (!sendEvent || !listConnected) return;
		const payloadJSON = toPayloadJSON(payload);
		for (const node of listConnected()) sendEvent({
			nodeId: node.nodeId,
			event,
			payloadJSON
		});
	};
	const clear = () => {
		nodeSubscriptions.clear();
		sessionSubscribers.clear();
	};
	return {
		subscribe,
		unsubscribe,
		unsubscribeAll,
		sendToSession,
		sendToAllSubscribed,
		sendToAllConnected,
		clear
	};
}
//#endregion
//#region src/gateway/server-talk-nodes.ts
const TALK_CAPABILITY = "talk";
const TALK_COMMAND_PREFIX = "talk.";
function hasConnectedTalkNode(registry) {
	return registry.listConnected().some(isTalkCapableNode);
}
function isTalkCapableNode(node) {
	return node.caps.some((capability) => normalizeOptionalLowercaseString(capability) === TALK_CAPABILITY) || node.commands.some((command) => normalizeOptionalLowercaseString(command)?.startsWith(TALK_COMMAND_PREFIX));
}
//#endregion
//#region src/gateway/server-node-session-runtime.ts
function createGatewayNodeSessionRuntime(params) {
	const nodeRegistry = new NodeRegistry();
	const nodePresenceTimers = /* @__PURE__ */ new Map();
	const nodeSubscriptions = createNodeSubscriptionManager();
	const sessionEventSubscribers = createSessionEventSubscriberRegistry();
	const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
	const nodeSendEvent = (opts) => {
		nodeRegistry.sendEventRaw(opts.nodeId, opts.event, opts.payloadJSON ?? null);
	};
	const nodeSendToSession = (sessionKey, event, payload) => nodeSubscriptions.sendToSession(sessionKey, event, payload, nodeSendEvent);
	const nodeSendToAllSubscribed = (event, payload) => nodeSubscriptions.sendToAllSubscribed(event, payload, nodeSendEvent);
	const broadcastVoiceWakeChanged = (triggers) => {
		params.broadcast("voicewake.changed", { triggers }, { dropIfSlow: true });
	};
	const hasTalkNodeConnected = () => hasConnectedTalkNode(nodeRegistry);
	return {
		nodeRegistry,
		nodePresenceTimers,
		sessionEventSubscribers,
		sessionMessageSubscribers,
		nodeSendToSession,
		nodeSendToAllSubscribed,
		nodeSubscribe: nodeSubscriptions.subscribe,
		nodeUnsubscribe: nodeSubscriptions.unsubscribe,
		nodeUnsubscribeAll: nodeSubscriptions.unsubscribeAll,
		broadcastVoiceWakeChanged,
		hasTalkNodeConnected
	};
}
//#endregion
export { createGatewayNodeSessionRuntime };
