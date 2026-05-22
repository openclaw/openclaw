import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import { y as truncateUtf16Safe } from "./utils-D5swhEXt.js";
import { i as isLoopbackHost, r as isLoopbackAddress } from "./net-CEscmVCn.js";
import { i as getRuntimeConfig } from "./io-C04VWQdx.js";
import { o as isWebchatClient } from "./message-channel-qkYXfTa4.js";
import { n as resolvePreauthHandshakeTimeoutMs } from "./handshake-timeouts-CYiQoW3s.js";
import { s as removeRemoteNodeInfo } from "./skills-remote-CJg703wl.js";
import { n as logWs } from "./ws-log-D6XyZt46.js";
import { n as logRejectedLargePayload } from "./diagnostic-payload-blKEuRbB.js";
import { a as MAX_PAYLOAD_BYTES, o as MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants-CwbR_uOb.js";
import { t as formatError } from "./server-utils-D9ob_rNH.js";
import { r as upsertPresence } from "./system-presence-CbSInf73.js";
import { a as incrementPresenceVersion, r as getHealthVersion } from "./health-state-vk5rIt3R.js";
import { i as clearNodeWakeState, t as broadcastPresenceSnapshot } from "./presence-events-B2Hb5kYU.js";
import { t as resolveSharedGatewaySessionGeneration } from "./ws-shared-generation-DSahfpHk.js";
import { randomUUID } from "node:crypto";
//#region src/infra/canvas-host-url.ts
const normalizeHost = (value, rejectLoopback) => {
	if (!value) return "";
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (rejectLoopback && isLoopbackHost(trimmed)) return "";
	return trimmed;
};
const parseHostHeader = (value) => {
	if (!value) return { host: "" };
	try {
		const parsed = new URL(`http://${value.trim()}`);
		const portRaw = parsed.port.trim();
		const port = portRaw ? Number.parseInt(portRaw, 10) : void 0;
		return {
			host: parsed.hostname,
			port: Number.isFinite(port) ? port : void 0
		};
	} catch {
		return { host: "" };
	}
};
const parseForwardedProto = (value) => {
	if (Array.isArray(value)) return value[0];
	return value;
};
function resolveCanvasHostUrl(params) {
	const port = params.canvasPort;
	if (!port) return;
	const scheme = params.scheme ?? (parseForwardedProto(params.forwardedProto)?.trim() === "https" ? "https" : "http");
	const override = normalizeHost(params.hostOverride, true);
	const parsedRequestHost = parseHostHeader(params.requestHost);
	const requestHost = normalizeHost(parsedRequestHost.host, !!override);
	const localAddress = normalizeHost(params.localAddress, Boolean(override || requestHost));
	const host = override || requestHost || localAddress;
	if (!host) return;
	let exposedPort = port;
	if (!override && requestHost && port === 18789) {
		if (parsedRequestHost.port && parsedRequestHost.port > 0) exposedPort = parsedRequestHost.port;
		else if (scheme === "https") exposedPort = 443;
		else if (scheme === "http") exposedPort = 80;
	}
	return `${scheme}://${host.includes(":") ? `[${host}]` : host}:${exposedPort}`;
}
//#endregion
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
	const rawSocket = socket._socket;
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
	import("./message-handler-CiEe61-M.js").then(({ attachGatewayWsMessageHandler }) => {
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
	const { wss, clients, preauthConnectionBudget, port, gatewayHost, canvasHostEnabled, canvasHostScheme, canvasHostServerPort, resolvedAuth, getResolvedAuth = () => resolvedAuth, getRequiredSharedGatewaySessionGeneration = () => resolveSharedGatewaySessionGeneration(getResolvedAuth(), getRuntimeConfig().gateway?.trustedProxies), rateLimiter, browserRateLimiter, isStartupPending, gatewayMethods, events, refreshHealthSnapshot, logGateway, logHealth, logWsControl, extraHandlers, broadcast, buildRequestContext } = params;
	const originCheckMetrics = { hostHeaderFallbackAccepted: 0 };
	wss.on("connection", (socket, upgradeReq) => {
		let client = null;
		let closed = false;
		const openedAt = Date.now();
		const connId = randomUUID();
		const { remoteAddr, remotePort, localAddr, localPort, endpoint } = resolveSocketAddress(socket);
		const preauthBudgetKey = socket.__openclawPreauthBudgetKey;
		socket.__openclawPreauthBudgetClaimed = true;
		const headerValue = (value) => Array.isArray(value) ? value[0] : value;
		const requestHost = headerValue(upgradeReq.headers.host);
		const requestOrigin = headerValue(upgradeReq.headers.origin);
		const requestUserAgent = headerValue(upgradeReq.headers["user-agent"]);
		const forwardedFor = headerValue(upgradeReq.headers["x-forwarded-for"]);
		const realIp = headerValue(upgradeReq.headers["x-real-ip"]);
		const canvasHostUrl = resolveCanvasHostUrl({
			canvasPort: canvasHostServerPort ?? (canvasHostEnabled ? port : void 0),
			hostOverride: canvasHostServerPort ? gatewayHost && gatewayHost !== "0.0.0.0" && gatewayHost !== "::" ? gatewayHost : void 0 : void 0,
			requestHost: upgradeReq.headers.host,
			forwardedProto: upgradeReq.headers["x-forwarded-proto"],
			localAddress: upgradeReq.socket?.localAddress,
			scheme: canvasHostScheme
		});
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
			if (!client) (isNoisySwiftPmHelperClose(requestUserAgent, remoteAddr) ? logWsControl.debug : logWsControl.warn)(`closed before connect conn=${connId} peer=${endpoint ?? "n/a"} remote=${remoteAddr ?? "?"} fwd=${logForwardedFor || "n/a"} origin=${logOrigin || "n/a"} host=${logHost || "n/a"} ua=${logUserAgent || "n/a"} code=${code ?? "n/a"} reason=${logReason || "n/a"}`, closeContext);
			if (client && isWebchatClient(client.connect.client)) logWsControl.info(`webchat disconnected code=${code} reason=${logReason || "n/a"} conn=${connId}`);
			if (client?.presenceKey) {
				upsertPresence(client.presenceKey, { reason: "disconnect" });
				broadcastPresenceSnapshot({
					broadcast,
					incrementPresenceVersion,
					getHealthVersion
				});
			}
			const context = buildRequestContext();
			context.unsubscribeAllSessionEvents(connId);
			if (client?.connect?.role === "node") {
				const nodeId = context.nodeRegistry.unregister(connId);
				if (nodeId) {
					removeRemoteNodeInfo(nodeId);
					context.nodeUnsubscribeAll(nodeId);
					clearNodeWakeState(nodeId);
				}
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
			canvasHostUrl,
			connectNonce,
			getResolvedAuth,
			getRequiredSharedGatewaySessionGeneration,
			rateLimiter,
			browserRateLimiter,
			isStartupPending,
			gatewayMethods,
			events,
			extraHandlers,
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
		canvasHostEnabled: params.canvasHostEnabled,
		canvasHostScheme: params.canvasHostScheme,
		canvasHostServerPort: params.canvasHostServerPort,
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
		broadcast: params.broadcast,
		buildRequestContext: () => params.context
	});
}
//#endregion
export { attachGatewayWsHandlers };
