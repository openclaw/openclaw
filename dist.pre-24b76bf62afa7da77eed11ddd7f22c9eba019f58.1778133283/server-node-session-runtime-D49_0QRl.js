import { s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { t as safeParseJson } from "./server-json-ctvCFUga.js";
import { i as createSessionMessageSubscriberRegistry, r as createSessionEventSubscriberRegistry } from "./server-chat-state-C2lQdotX.js";
import { randomUUID } from "node:crypto";
//#region src/gateway/node-registry.ts
var NodeRegistry = class {
	constructor() {
		this.nodesById = /* @__PURE__ */ new Map();
		this.nodesByConn = /* @__PURE__ */ new Map();
		this.pendingInvokes = /* @__PURE__ */ new Map();
	}
	register(client, opts) {
		const connect = client.connect;
		const nodeId = connect.device?.id ?? connect.client.id;
		const caps = Array.isArray(connect.caps) ? connect.caps : [];
		const commands = Array.isArray(connect.commands) ? connect.commands ?? [] : [];
		const permissions = typeof connect.permissions === "object" ? connect.permissions ?? void 0 : void 0;
		const pathEnv = typeof connect.pathEnv === "string" ? connect.pathEnv : void 0;
		const session = {
			nodeId,
			connId: client.connId,
			client,
			clientId: connect.client.id,
			clientMode: connect.client.mode,
			displayName: connect.client.displayName,
			platform: connect.client.platform,
			version: connect.client.version,
			coreVersion: connect.coreVersion,
			uiVersion: connect.uiVersion,
			deviceFamily: connect.client.deviceFamily,
			modelIdentifier: connect.client.modelIdentifier,
			remoteIp: opts.remoteIp,
			caps,
			commands,
			permissions,
			pathEnv,
			connectedAtMs: Date.now()
		};
		this.nodesById.set(nodeId, session);
		this.nodesByConn.set(client.connId, nodeId);
		return session;
	}
	unregister(connId) {
		const nodeId = this.nodesByConn.get(connId);
		if (!nodeId) return null;
		this.nodesByConn.delete(connId);
		this.nodesById.delete(nodeId);
		for (const [id, pending] of this.pendingInvokes.entries()) {
			if (pending.nodeId !== nodeId) continue;
			clearTimeout(pending.timer);
			pending.reject(/* @__PURE__ */ new Error(`node disconnected (${pending.command})`));
			this.pendingInvokes.delete(id);
		}
		return nodeId;
	}
	listConnected() {
		return [...this.nodesById.values()];
	}
	get(nodeId) {
		return this.nodesById.get(nodeId);
	}
	async invoke(params) {
		const node = this.nodesById.get(params.nodeId);
		if (!node) return {
			ok: false,
			error: {
				code: "NOT_CONNECTED",
				message: "node not connected"
			}
		};
		const requestId = randomUUID();
		const payload = {
			id: requestId,
			nodeId: params.nodeId,
			command: params.command,
			paramsJSON: "params" in params && params.params !== void 0 ? JSON.stringify(params.params) : null,
			timeoutMs: params.timeoutMs,
			idempotencyKey: params.idempotencyKey
		};
		if (!this.sendEventToSession(node, "node.invoke.request", payload)) return {
			ok: false,
			error: {
				code: "UNAVAILABLE",
				message: "failed to send invoke to node"
			}
		};
		const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 3e4;
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingInvokes.delete(requestId);
				resolve({
					ok: false,
					error: {
						code: "TIMEOUT",
						message: "node invoke timed out"
					}
				});
			}, timeoutMs);
			this.pendingInvokes.set(requestId, {
				nodeId: params.nodeId,
				command: params.command,
				resolve,
				reject,
				timer
			});
		});
	}
	handleInvokeResult(params) {
		const pending = this.pendingInvokes.get(params.id);
		if (!pending) return false;
		if (pending.nodeId !== params.nodeId) return false;
		clearTimeout(pending.timer);
		this.pendingInvokes.delete(params.id);
		pending.resolve({
			ok: params.ok,
			payload: params.payload,
			payloadJSON: params.payloadJSON ?? null,
			error: params.error ?? null
		});
		return true;
	}
	sendEvent(nodeId, event, payload) {
		const node = this.nodesById.get(nodeId);
		if (!node) return false;
		return this.sendEventToSession(node, event, payload);
	}
	sendEventInternal(node, event, payload) {
		try {
			node.client.socket.send(JSON.stringify({
				type: "event",
				event,
				payload
			}));
			return true;
		} catch {
			return false;
		}
	}
	sendEventToSession(node, event, payload) {
		return this.sendEventInternal(node, event, payload);
	}
};
//#endregion
//#region src/gateway/server-mobile-nodes.ts
function hasConnectedMobileNode(registry) {
	return registry.listConnected().some((n) => {
		const platform = normalizeOptionalLowercaseString(n.platform) ?? "";
		return platform.startsWith("ios") || platform.startsWith("ipados") || platform.startsWith("android");
	});
}
//#endregion
//#region src/gateway/server-node-subscriptions.ts
function createNodeSubscriptionManager() {
	const nodeSubscriptions = /* @__PURE__ */ new Map();
	const sessionSubscribers = /* @__PURE__ */ new Map();
	const toPayloadJSON = (payload) => payload ? JSON.stringify(payload) : null;
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
//#region src/gateway/server-node-session-runtime.ts
function createGatewayNodeSessionRuntime(params) {
	const nodeRegistry = new NodeRegistry();
	const nodePresenceTimers = /* @__PURE__ */ new Map();
	const nodeSubscriptions = createNodeSubscriptionManager();
	const sessionEventSubscribers = createSessionEventSubscriberRegistry();
	const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
	const nodeSendEvent = (opts) => {
		const payload = safeParseJson(opts.payloadJSON ?? null);
		nodeRegistry.sendEvent(opts.nodeId, opts.event, payload);
	};
	const nodeSendToSession = (sessionKey, event, payload) => nodeSubscriptions.sendToSession(sessionKey, event, payload, nodeSendEvent);
	const nodeSendToAllSubscribed = (event, payload) => nodeSubscriptions.sendToAllSubscribed(event, payload, nodeSendEvent);
	const broadcastVoiceWakeChanged = (triggers) => {
		params.broadcast("voicewake.changed", { triggers }, { dropIfSlow: true });
	};
	const hasMobileNodeConnected = () => hasConnectedMobileNode(nodeRegistry);
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
		hasMobileNodeConnected
	};
}
//#endregion
export { createGatewayNodeSessionRuntime };
