import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { y as truncateUtf16Safe } from "./utils-sBTEdeml.js";
import { r as isLoopbackAddress } from "./net-DCUMtgJy.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { o as isWebchatClient } from "./message-channel-CYCKkVrh.js";
import { n as resolvePreauthHandshakeTimeoutMs } from "./handshake-timeouts-DRUWxVZ0.js";
import "./client-B1EH_7Mz.js";
import { n as logRejectedLargePayload } from "./diagnostic-payload-DTCZLTc7.js";
import { a as MAX_PAYLOAD_BYTES, o as MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants-BGwLM6XN.js";
import { t as resolveHostedPluginSurfaceUrl } from "./hosted-plugin-surface-url-52L_Bva6.js";
import { n as logWs } from "./ws-log-Ds39xp21.js";
import { s as removeRemoteNodeInfo } from "./skills-remote-BCbpja7h.js";
import { t as formatError } from "./server-utils-9y0vZuz2.js";
import { r as upsertPresence } from "./system-presence-Cj1j_O4u.js";
import { a as incrementPresenceVersion, r as getHealthVersion } from "./health-state-DDBJpyWb.js";
import { i as clearNodeWakeState, t as broadcastPresenceSnapshot } from "./presence-events-BpQxlCGY.js";
import { t as resolveSharedGatewaySessionGeneration } from "./ws-shared-generation-Bp5l7wzu.js";
import { randomUUID } from "node:crypto";
//#region src/gateway/server/ws-connection.ts
const LOG_HEADER_MAX_LEN = 300;
const LOG_HEADER_FORMAT_REGEX = /\p{Cf}/gu;
const MAX_QUEUED_MESSAGE_HANDLER_FRAMES = 16;
function replaceControlChars(value) {
	let cleaned = "";
	for (const char of value) {
		const codePoint = char.codePointAt(0);
		if (codePoint !== void 0 && (codePoint <= 31 || codePoint >= 127 && codePoint <= 159)) {
			cleaned += " ";
			continue;
		}
		cleaned += char;
	}
	return cleaned;
}
const sanitizeLogValue = (value) => {
	if (!value) return;
	const cleaned = replaceControlChars(value).replace(LOG_HEADER_FORMAT_REGEX, " ").replace(/\s+/g, " ").trim();
	if (!cleaned) return;
	if (cleaned.length <= LOG_HEADER_MAX_LEN) return cleaned;
	return truncateUtf16Safe(cleaned, LOG_HEADER_MAX_LEN);
};
function formatSocketEndpoint(address, port) {
	if (!address) return;
	if (port === void 0) return address;
	return address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
}
function resolveSocketAddress(socket) {
	const rawSocket = socket["_socket"];
	const remoteAddr = rawSocket?.remoteAddress;
	const remotePort = rawSocket?.remotePort;
	const localAddr = rawSocket?.localAddress;
	const localPort = rawSocket?.localPort;
	const remoteEndpoint = formatSocketEndpoint(remoteAddr, remotePort);
	const localEndpoint = formatSocketEndpoint(localAddr, localPort);
	return {
		remoteAddr,
		remotePort,
		localAddr,
		localPort,
		endpoint: remoteEndpoint && localEndpoint ? `${remoteEndpoint}->${localEndpoint}` : remoteEndpoint ?? localEndpoint
	};
}
function isWsPayloadLimitError(err) {
	if (!err || typeof err !== "object") return false;
	if (err.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") return true;
	const message = err.message;
	return typeof message === "string" && /max payload size exceeded/i.test(message);
}
function attachGatewayWsMessageHandlerOnDemand(params) {
	const queued = [];
	const queueMessage = (data) => {
		if (queued.length >= MAX_QUEUED_MESSAGE_HANDLER_FRAMES) {
			params.setCloseCause("message-handler-loading-overflow", { queuedFrames: queued.length });
			params.close(1008, "gateway message handler loading");
			return;
		}
		queued.push(data);
	};
	params.socket.on("message", queueMessage);
	import("./message-handler-CPg1dnip.js").then(({ attachGatewayWsMessageHandler }) => {
		params.socket.off("message", queueMessage);
		if (params.isClosed()) return;
		attachGatewayWsMessageHandler(params);
		for (const data of queued) params.socket.emit("message", data);
	}).catch((error) => {
		params.socket.off("message", queueMessage);
		params.setCloseCause("message-handler-load-failed", { error: formatError(error) });
		params.logWsControl.warn(`failed to load ws message handler conn=${params.connId}: ${formatError(error)}`);
		params.close(1011, "gateway message handler unavailable");
	});
}
function attachGatewayWsConnectionHandler(params) {
	const { wss, clients, preauthConnectionBudget, port, pluginSurfaceScheme, getPluginNodeCapabilities, resolvedAuth, getResolvedAuth = () => resolvedAuth, getRequiredSharedGatewaySessionGeneration = () => resolveSharedGatewaySessionGeneration(getResolvedAuth(), getRuntimeConfig().gateway?.trustedProxies), rateLimiter, browserRateLimiter, isStartupPending, gatewayMethods, events, refreshHealthSnapshot, logGateway, logHealth, logWsControl, extraHandlers, getMethodRegistry, broadcast, buildRequestContext } = params;
	const originCheckMetrics = { hostHeaderFallbackAccepted: 0 };
	wss.on("connection", (socket, upgradeReq) => {
		let client = null;
		let closed = false;
		const openedAt = Date.now();
		const connId = randomUUID();
		const { remoteAddr, remotePort, localAddr, localPort, endpoint } = resolveSocketAddress(socket);
		const preauthBudgetKey = socket["__openclawPreauthBudgetKey"];
		socket["__openclawPreauthBudgetClaimed"] = true;
		const headerValue = (value) => Array.isArray(value) ? value[0] : value;
		const requestHost = headerValue(upgradeReq.headers.host);
		const requestOrigin = headerValue(upgradeReq.headers.origin);
		const requestUserAgent = headerValue(upgradeReq.headers["user-agent"]);
		const forwardedFor = headerValue(upgradeReq.headers["x-forwarded-for"]);
		const realIp = headerValue(upgradeReq.headers["x-real-ip"]);
		const pluginNodeCapabilities = getPluginNodeCapabilities?.() ?? [];
		const pluginSurfaceBaseUrl = pluginNodeCapabilities.length > 0 ? resolveHostedPluginSurfaceUrl({
			port,
			forwardedHost: upgradeReq.headers["x-forwarded-host"],
			requestHost: upgradeReq.headers.host,
			forwardedProto: upgradeReq.headers["x-forwarded-proto"],
			localAddress: upgradeReq.socket?.localAddress,
			scheme: pluginSurfaceScheme
		}) : void 0;
		logWs("in", "open", {
			connId,
			remoteAddr,
			remotePort,
			localAddr,
			localPort,
			endpoint
		});
		let handshakeState = "pending";
		let holdsPreauthBudget = true;
		let closeCause;
		let closeMeta = {};
		let lastFrameType;
		let lastFrameMethod;
		let lastFrameId;
		const setCloseCause = (cause, meta) => {
			if (!closeCause) closeCause = cause;
			if (meta && Object.keys(meta).length > 0) closeMeta = {
				...closeMeta,
				...meta
			};
		};
		const releasePreauthBudget = () => {
			if (!holdsPreauthBudget) return;
			holdsPreauthBudget = false;
			preauthConnectionBudget.release(preauthBudgetKey);
		};
		const setLastFrameMeta = (meta) => {
			if (meta.type || meta.method || meta.id) {
				lastFrameType = meta.type ?? lastFrameType;
				lastFrameMethod = meta.method ?? lastFrameMethod;
				lastFrameId = meta.id ?? lastFrameId;
			}
		};
		const send = (obj) => {
			try {
				socket.send(JSON.stringify(obj));
			} catch {}
		};
		const connectNonce = randomUUID();
		send({
			type: "event",
			event: "connect.challenge",
			payload: {
				nonce: connectNonce,
				ts: Date.now()
			}
		});
		let pingTimer;
		const close = (code = 1e3, reason) => {
			if (closed) return;
			closed = true;
			clearTimeout(handshakeTimer);
			if (pingTimer !== void 0) clearInterval(pingTimer);
			releasePreauthBudget();
			if (client) clients.delete(client);
			try {
				socket.close(code, reason);
			} catch {}
		};
		socket.once("error", (err) => {
			if (isWsPayloadLimitError(err)) logRejectedLargePayload({
				surface: client ? "gateway.ws.frame" : "gateway.ws.preauth",
				limitBytes: client ? MAX_PAYLOAD_BYTES : MAX_PREAUTH_PAYLOAD_BYTES,
				reason: client ? "ws_frame_limit" : "preauth_frame_limit"
			});
			logWsControl.warn(`error conn=${connId} remote=${remoteAddr ?? "?"}: ${formatError(err)}`);
			close();
		});
		const isNoisySwiftPmHelperClose = (userAgent, remote) => normalizeLowercaseStringOrEmpty(userAgent).includes("swiftpm-testing-helper") && isLoopbackAddress(remote);
		socket.once("close", (code, reason) => {
			const durationMs = Date.now() - openedAt;
			const logForwardedFor = sanitizeLogValue(forwardedFor);
			const logOrigin = sanitizeLogValue(requestOrigin);
			const logHost = sanitizeLogValue(requestHost);
			const logUserAgent = sanitizeLogValue(requestUserAgent);
			const logReason = sanitizeLogValue(reason?.toString());
			const closeContext = {
				cause: closeCause,
				handshake: handshakeState,
				durationMs,
				lastFrameType,
				lastFrameMethod,
				lastFrameId,
				host: logHost,
				origin: logOrigin,
				userAgent: logUserAgent,
				forwardedFor: logForwardedFor,
				remoteAddr,
				remotePort,
				localAddr,
				localPort,
				endpoint,
				...closeMeta
			};
			if (!client) {
				const isExpectedStartupRetryClose = closeCause === "startup-sidecars-pending" && code === 1013;
				(isNoisySwiftPmHelperClose(requestUserAgent, remoteAddr) || isExpectedStartupRetryClose ? logWsControl.debug : logWsControl.warn)(`closed before connect conn=${connId} peer=${endpoint ?? "n/a"} remote=${remoteAddr ?? "?"} fwd=${logForwardedFor || "n/a"} origin=${logOrigin || "n/a"} host=${logHost || "n/a"} ua=${logUserAgent || "n/a"} code=${code ?? "n/a"} reason=${logReason || "n/a"}`, closeContext);
			}
			if (client && isWebchatClient(client.connect.client)) logWsControl.info(`webchat disconnected code=${code} reason=${logReason || "n/a"} conn=${connId}`);
			const context = buildRequestContext();
			context.unsubscribeAllSessionEvents(connId);
			let currentDisconnectedNodeId = null;
			if (client?.connect?.role === "node") currentDisconnectedNodeId = context.nodeRegistry.unregister(connId);
			if (client?.presenceKey && (client.connect.role !== "node" || currentDisconnectedNodeId !== null)) {
				upsertPresence(client.presenceKey, { reason: "disconnect" });
				broadcastPresenceSnapshot({
					broadcast,
					incrementPresenceVersion,
					getHealthVersion
				});
			}
			if (currentDisconnectedNodeId) {
				removeRemoteNodeInfo(currentDisconnectedNodeId);
				context.nodeUnsubscribeAll(currentDisconnectedNodeId);
				clearNodeWakeState(currentDisconnectedNodeId);
			}
			logWs("out", "close", {
				connId,
				code,
				reason: logReason,
				durationMs,
				cause: closeCause,
				handshake: handshakeState,
				lastFrameType,
				lastFrameMethod,
				lastFrameId,
				endpoint
			});
			close();
		});
		const handshakeTimeoutMs = resolvePreauthHandshakeTimeoutMs({ configuredTimeoutMs: params.preauthHandshakeTimeoutMs });
		const handshakeTimer = setTimeout(() => {
			if (!client) {
				handshakeState = "failed";
				setCloseCause("handshake-timeout", {
					handshakeMs: Date.now() - openedAt,
					endpoint
				});
				logWsControl.warn(`handshake timeout conn=${connId} peer=${endpoint ?? "n/a"} remote=${remoteAddr ?? "?"}`);
				close();
			}
		}, handshakeTimeoutMs);
		attachGatewayWsMessageHandlerOnDemand({
			socket,
			upgradeReq,
			connId,
			remoteAddr,
			remotePort,
			localAddr,
			localPort,
			endpoint,
			forwardedFor,
			realIp,
			requestHost,
			requestOrigin,
			requestUserAgent,
			pluginSurfaceBaseUrl,
			pluginNodeCapabilities,
			connectNonce,
			getResolvedAuth,
			getRequiredSharedGatewaySessionGeneration,
			rateLimiter,
			browserRateLimiter,
			isStartupPending,
			gatewayMethods,
			events,
			extraHandlers,
			getMethodRegistry,
			buildRequestContext,
			refreshHealthSnapshot,
			send,
			close,
			isClosed: () => closed,
			clearHandshakeTimer: () => clearTimeout(handshakeTimer),
			getClient: () => client,
			setClient: (next) => {
				if (closed) return false;
				releasePreauthBudget();
				client = next;
				clients.add(next);
				pingTimer = setInterval(() => {
					try {
						socket.ping();
					} catch {}
				}, 25e3);
				return true;
			},
			setHandshakeState: (next) => {
				handshakeState = next;
			},
			setCloseCause,
			setLastFrameMeta,
			originCheckMetrics,
			logGateway,
			logHealth,
			logWsControl
		});
	});
}
//#endregion
//#region src/gateway/server-ws-runtime.ts
function attachGatewayWsHandlers(params) {
	attachGatewayWsConnectionHandler({
		wss: params.wss,
		clients: params.clients,
		preauthConnectionBudget: params.preauthConnectionBudget,
		port: params.port,
		gatewayHost: params.gatewayHost,
		pluginSurfaceScheme: params.pluginSurfaceScheme,
		getPluginNodeCapabilities: params.getPluginNodeCapabilities,
		resolvedAuth: params.resolvedAuth,
		getResolvedAuth: params.getResolvedAuth,
		getRequiredSharedGatewaySessionGeneration: params.getRequiredSharedGatewaySessionGeneration,
		rateLimiter: params.rateLimiter,
		browserRateLimiter: params.browserRateLimiter,
		preauthHandshakeTimeoutMs: params.preauthHandshakeTimeoutMs,
		isStartupPending: params.isStartupPending,
		gatewayMethods: params.gatewayMethods,
		events: params.events,
		refreshHealthSnapshot: params.context.refreshHealthSnapshot,
		logGateway: params.logGateway,
		logHealth: params.logHealth,
		logWsControl: params.logWsControl,
		extraHandlers: params.extraHandlers,
		getMethodRegistry: params.getMethodRegistry,
		broadcast: params.broadcast,
		buildRequestContext: () => params.context
	});
}
//#endregion
export { attachGatewayWsHandlers };
