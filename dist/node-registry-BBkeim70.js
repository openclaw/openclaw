import { n as logRejectedLargePayload } from "./diagnostic-payload-DTCZLTc7.js";
import { i as MAX_BUFFERED_BYTES } from "./server-constants-BGwLM6XN.js";
import { randomUUID } from "node:crypto";
//#region src/gateway/node-registry.ts
const SERIALIZED_EVENT_PAYLOAD = Symbol("openclaw.serializedEventPayload");
const AUTHORIZED_SYSTEM_RUN_EVENT_GRACE_MS = 300 * 1e3;
const WEBSOCKET_OPEN_READY_STATE = 1;
const SLOW_CONSUMER_CLOSE_CODE = 1008;
function serializeEventPayload(payload) {
	if (!payload) return null;
	const json = JSON.stringify(payload);
	return typeof json === "string" ? {
		json,
		[SERIALIZED_EVENT_PAYLOAD]: true
	} : null;
}
function isSerializedEventPayload(value) {
	return typeof value === "object" && value !== null && value[SERIALIZED_EVENT_PAYLOAD] === true && typeof value.json === "string";
}
function normalizeString(value) {
	return typeof value === "string" ? value.trim() : "";
}
function normalizeSystemRunTimeoutMs(value) {
	if (value === void 0) return;
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	const timeoutMs = Math.trunc(value);
	return timeoutMs > 0 ? timeoutMs : null;
}
function resolvePendingSystemRunEvent(params) {
	if (params.command !== "system.run" || !params.params || typeof params.params !== "object") return;
	const obj = params.params;
	const runId = normalizeString(obj.runId);
	if (!runId) return;
	const timeoutMs = normalizeSystemRunTimeoutMs(obj.timeoutMs);
	const sessionKey = normalizeString(obj.sessionKey);
	return {
		runId,
		...sessionKey ? { sessionKey } : {},
		...timeoutMs !== void 0 ? { timeoutMs } : {}
	};
}
function withSystemRunEventRunId(params) {
	if (params.command !== "system.run" || !params.params || typeof params.params !== "object" || Array.isArray(params.params)) return params.params;
	const obj = params.params;
	if (normalizeString(obj.runId)) return params.params;
	return {
		...obj,
		runId: randomUUID()
	};
}
var NodeRegistry = class {
	constructor() {
		this.nodesById = /* @__PURE__ */ new Map();
		this.nodesByConn = /* @__PURE__ */ new Map();
		this.pendingInvokes = /* @__PURE__ */ new Map();
		this.authorizedSystemRunEvents = /* @__PURE__ */ new Map();
	}
	register(client, opts) {
		const connect = client.connect;
		const nodeId = connect.device?.id ?? connect.client.id;
		const caps = Array.isArray(connect.caps) ? connect.caps : [];
		const declaredCaps = Array.isArray(connect.declaredCaps) ? connect.declaredCaps ?? [] : caps;
		const commands = Array.isArray(connect.commands) ? connect.commands ?? [] : [];
		const declaredCommands = Array.isArray(connect.declaredCommands) ? connect.declaredCommands ?? [] : commands;
		const permissions = typeof connect.permissions === "object" ? connect.permissions ?? void 0 : void 0;
		const declaredPermissions = typeof connect.declaredPermissions === "object" ? connect.declaredPermissions ?? void 0 : permissions;
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
			declaredCaps,
			caps,
			declaredCommands,
			commands,
			declaredPermissions,
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
		const unregistersCurrentNode = this.nodesById.get(nodeId)?.connId === connId;
		if (unregistersCurrentNode) this.nodesById.delete(nodeId);
		for (const [id, pending] of this.pendingInvokes.entries()) {
			if (pending.connId !== connId) continue;
			clearTimeout(pending.timer);
			pending.reject(/* @__PURE__ */ new Error(`node disconnected (${pending.command})`));
			this.pendingInvokes.delete(id);
		}
		for (const [key, event] of this.authorizedSystemRunEvents) if (event.connId === connId) this.authorizedSystemRunEvents.delete(key);
		return unregistersCurrentNode ? nodeId : null;
	}
	listConnected() {
		return [...this.nodesById.values()];
	}
	get(nodeId) {
		return this.nodesById.get(nodeId);
	}
	async checkConnectivity(nodeId, timeoutMs = 2e3) {
		const node = this.nodesById.get(nodeId);
		if (!node) return {
			ok: false,
			error: {
				code: "NOT_CONNECTED",
				message: "node not connected"
			}
		};
		const socket = node.client.socket;
		if (socket.readyState !== WEBSOCKET_OPEN_READY_STATE) return {
			ok: false,
			error: {
				code: "NOT_CONNECTED",
				message: "node socket not open"
			}
		};
		if (typeof socket.ping !== "function" || typeof socket.once !== "function") return { ok: true };
		const timeout = Math.max(1, Math.trunc(timeoutMs));
		return await new Promise((resolve) => {
			let settled = false;
			const cleanup = () => {
				socket.off?.("pong", onPong);
				socket.off?.("close", onClose);
				socket.off?.("error", onError);
				socket.removeListener?.("pong", onPong);
				socket.removeListener?.("close", onClose);
				socket.removeListener?.("error", onError);
			};
			const finish = (result) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				cleanup();
				resolve(result);
			};
			const onPong = () => finish({ ok: true });
			const onClose = () => finish({
				ok: false,
				error: {
					code: "NOT_CONNECTED",
					message: "node socket closed during connectivity probe"
				}
			});
			const onError = (err) => finish({
				ok: false,
				error: {
					code: "UNAVAILABLE",
					message: err instanceof Error ? err.message : "node socket error during connectivity probe"
				}
			});
			const timer = setTimeout(() => finish({
				ok: false,
				error: {
					code: "TIMEOUT",
					message: "node connectivity probe timed out"
				}
			}), timeout);
			socket.once?.("pong", onPong);
			socket.once?.("close", onClose);
			socket.once?.("error", onError);
			try {
				socket.ping?.(void 0, false, (err) => {
					if (err) finish({
						ok: false,
						error: {
							code: "UNAVAILABLE",
							message: err.message
						}
					});
				});
			} catch (err) {
				finish({
					ok: false,
					error: {
						code: "UNAVAILABLE",
						message: err instanceof Error ? err.message : "node ping failed"
					}
				});
			}
		});
	}
	updateCommands(nodeId, commands) {
		return this.updateSurface(nodeId, { commands });
	}
	updateSurface(nodeId, surface) {
		const node = this.nodesById.get(nodeId);
		if (!node) return null;
		const declaredCommands = new Set(node.declaredCommands);
		const nextCommands = surface.commands.filter((command) => declaredCommands.has(command));
		node.commands = nextCommands;
		node.client.connect.commands = nextCommands;
		if ("caps" in surface) {
			const declaredCaps = new Set(node.declaredCaps);
			const nextCaps = (surface.caps ?? []).filter((capability) => declaredCaps.has(capability));
			node.caps = nextCaps;
			node.client.connect.caps = nextCaps;
		}
		if ("permissions" in surface) {
			if (surface.permissions === void 0) {
				node.permissions = void 0;
				node.client.connect.permissions = void 0;
				return node;
			}
			const declared = node.declaredPermissions ?? {};
			const nextEntries = [];
			for (const [key, declaredValue] of Object.entries(declared)) {
				if (!declaredValue) {
					nextEntries.push([key, false]);
					continue;
				}
				const approvedValue = surface.permissions?.[key];
				if (approvedValue) {
					nextEntries.push([key, true]);
					continue;
				}
				if (approvedValue !== void 0) nextEntries.push([key, false]);
			}
			const nextPermissions = nextEntries.length > 0 ? Object.fromEntries(nextEntries) : void 0;
			node.permissions = nextPermissions;
			node.client.connect.permissions = nextPermissions;
		}
		return node;
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
		const invokeParams = withSystemRunEventRunId({
			command: params.command,
			params: params.params
		});
		const payload = {
			id: requestId,
			nodeId: params.nodeId,
			command: params.command,
			paramsJSON: "params" in params && invokeParams !== void 0 ? JSON.stringify(invokeParams) : null,
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
		const systemRunEvent = resolvePendingSystemRunEvent({
			command: params.command,
			params: invokeParams
		});
		if (systemRunEvent) this.rememberAuthorizedSystemRunEvent({
			nodeId: params.nodeId,
			connId: node.connId,
			...systemRunEvent
		});
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
				connId: node.connId,
				command: params.command,
				systemRunEvent,
				resolve,
				reject,
				timer
			});
		});
	}
	authorizeSystemRunEvent(params) {
		if (!params.connId || !params.sessionKey) return false;
		const connId = params.connId;
		this.pruneAuthorizedSystemRunEvents();
		let match = null;
		if (params.runId) {
			match = this.matchAuthorizedSystemRunEvent({
				nodeId: params.nodeId,
				connId,
				runId: params.runId,
				sessionKey: params.sessionKey
			});
			if (!match && this.allowsLegacyMacRunIdFallback({
				nodeId: params.nodeId,
				connId
			})) match = this.matchSingleAuthorizedSystemRunEvent({
				nodeId: params.nodeId,
				connId,
				sessionKey: params.sessionKey
			});
		} else {
			if (!this.allowsLegacyMacRunIdFallback({
				nodeId: params.nodeId,
				connId
			})) return false;
			match = this.matchSingleAuthorizedSystemRunEvent({
				nodeId: params.nodeId,
				connId,
				sessionKey: params.sessionKey
			});
		}
		if (!match) return false;
		if (params.terminal) this.authorizedSystemRunEvents.delete(match.key);
		return true;
	}
	rememberAuthorizedSystemRunEvent(event) {
		this.pruneAuthorizedSystemRunEvents();
		const authorized = {
			...event,
			expiresAtMs: this.authorizedSystemRunEventExpiresAt(event.timeoutMs)
		};
		this.authorizedSystemRunEvents.set(this.authorizedSystemRunEventKey(authorized), authorized);
	}
	forgetAuthorizedSystemRunEvent(event) {
		this.authorizedSystemRunEvents.delete(this.authorizedSystemRunEventKey(event));
	}
	authorizedSystemRunEventExpiresAt(timeoutMs) {
		if (typeof timeoutMs !== "number") return null;
		return Date.now() + timeoutMs + AUTHORIZED_SYSTEM_RUN_EVENT_GRACE_MS;
	}
	matchAuthorizedSystemRunEvent(params) {
		for (const [key, event] of this.authorizedSystemRunEvents) if (event.nodeId === params.nodeId && event.connId === params.connId && event.runId === params.runId && this.authorizedSystemRunSessionMatches(event, params.sessionKey)) return {
			key,
			event
		};
		return null;
	}
	matchSingleAuthorizedSystemRunEvent(params) {
		let match = null;
		for (const [key, event] of this.authorizedSystemRunEvents) {
			if (event.nodeId !== params.nodeId || event.connId !== params.connId || !this.authorizedSystemRunSessionMatches(event, params.sessionKey)) continue;
			if (match) return null;
			match = {
				key,
				event
			};
		}
		return match;
	}
	authorizedSystemRunSessionMatches(event, sessionKey) {
		return !event.sessionKey || event.sessionKey === sessionKey;
	}
	allowsLegacyMacRunIdFallback(params) {
		const node = this.nodesById.get(params.nodeId);
		return node?.connId === params.connId && node.clientId === "openclaw-macos" && node.platform === "darwin";
	}
	pruneAuthorizedSystemRunEvents(now = Date.now()) {
		for (const [key, event] of this.authorizedSystemRunEvents) if (event.expiresAtMs !== null && event.expiresAtMs <= now) this.authorizedSystemRunEvents.delete(key);
	}
	authorizedSystemRunEventKey(params) {
		return `${params.nodeId}\0${params.connId}\0${params.sessionKey ?? ""}\0${params.runId}`;
	}
	handleInvokeResult(params) {
		const pending = this.pendingInvokes.get(params.id);
		if (!pending) return false;
		if (pending.nodeId !== params.nodeId || pending.connId !== params.connId) return false;
		clearTimeout(pending.timer);
		this.pendingInvokes.delete(params.id);
		if (!params.ok && pending.systemRunEvent) this.forgetAuthorizedSystemRunEvent({
			nodeId: pending.nodeId,
			connId: pending.connId,
			...pending.systemRunEvent
		});
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
	sendEventRaw(nodeId, event, payloadJSON) {
		const node = this.nodesById.get(nodeId);
		if (!node) return false;
		return this.sendEventRawInternal(node, event, payloadJSON);
	}
	sendEventInternal(node, event, payload) {
		if (this.rejectSlowNodeSocket(node)) return false;
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
	sendEventRawInternal(node, event, payloadJSON) {
		if (payloadJSON !== null && payloadJSON !== void 0 && !isSerializedEventPayload(payloadJSON)) return false;
		if (this.rejectSlowNodeSocket(node)) return false;
		try {
			const payloadFragment = payloadJSON ? `,"payload":${payloadJSON.json}` : "";
			node.client.socket.send(`{"type":"event","event":${JSON.stringify(event)}${payloadFragment}}`);
			return true;
		} catch {
			return false;
		}
	}
	sendEventToSession(node, event, payload) {
		return this.sendEventInternal(node, event, payload);
	}
	rejectSlowNodeSocket(node) {
		if (!(node.client.socket.bufferedAmount > 52428800)) return false;
		logRejectedLargePayload({
			surface: "gateway.ws.outbound_buffer",
			bytes: node.client.socket.bufferedAmount,
			limitBytes: MAX_BUFFERED_BYTES,
			reason: "ws_send_buffer_close"
		});
		try {
			node.client.socket.close(SLOW_CONSUMER_CLOSE_CODE, "slow consumer");
		} catch {}
		return true;
	}
};
//#endregion
export { serializeEventPayload as n, NodeRegistry as t };
