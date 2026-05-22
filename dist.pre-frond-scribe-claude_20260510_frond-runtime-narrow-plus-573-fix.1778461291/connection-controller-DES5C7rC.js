import { n as clamp } from "./utils-927g1oFZ.js";
import { n as info } from "./globals-ZEce9oym.js";
import { n as sleepWithAbort, t as computeBackoff } from "./backoff-CGrdodVs.js";
import "./text-runtime-CEUy8PW0.js";
import "./runtime-env-BAVnmgBK.js";
import { n as registerWhatsAppConnectionController, r as unregisterWhatsAppConnectionController } from "./connection-controller-registry-DUbW7m4k.js";
import { n as getStatusCode, t as formatError } from "./session-errors-CveU5IhS.js";
import { s as logoutWeb } from "./auth-store-DyMquPtV.js";
import { d as DisconnectReason } from "./session.runtime-Cy2xnenc.js";
import { r as waitForWaConnection, t as createWaSocket } from "./session-CaY1sE5B.js";
import { randomUUID } from "node:crypto";
const DEFAULT_RECONNECT_POLICY = {
	initialMs: 2e3,
	maxMs: 3e4,
	factor: 1.8,
	jitter: .25,
	maxAttempts: 12
};
function resolveHeartbeatSeconds(cfg, overrideSeconds) {
	const candidate = overrideSeconds ?? cfg.web?.heartbeatSeconds;
	if (typeof candidate === "number" && candidate > 0) return candidate;
	return 60;
}
function resolveReconnectPolicy(cfg, overrides) {
	const reconnectOverrides = cfg.web?.reconnect ?? {};
	const overrideConfig = overrides ?? {};
	const merged = {
		...DEFAULT_RECONNECT_POLICY,
		...reconnectOverrides,
		...overrideConfig
	};
	merged.initialMs = Math.max(250, merged.initialMs);
	merged.maxMs = Math.max(merged.initialMs, merged.maxMs);
	merged.factor = clamp(merged.factor, 1.1, 10);
	merged.jitter = clamp(merged.jitter, 0, 1);
	merged.maxAttempts = Math.max(0, Math.floor(merged.maxAttempts));
	return merged;
}
function newConnectionId() {
	return randomUUID();
}
//#endregion
//#region extensions/whatsapp/src/connection-controller.ts
const LOGGED_OUT_STATUS = DisconnectReason?.loggedOut ?? 401;
const WHATSAPP_LOGIN_RESTART_MESSAGE = "WhatsApp asked for a restart after pairing (code 515); waiting for creds to save…";
const WHATSAPP_LOGGED_OUT_RELINK_MESSAGE = "WhatsApp reported the session is logged out. Cleared cached web session; please rerun openclaw channels login and scan the QR again.";
const WHATSAPP_LOGGED_OUT_QR_MESSAGE = "WhatsApp reported the session is logged out. Cleared cached web session; please scan a new QR.";
function createNeverResolvePromise() {
	return new Promise(() => {});
}
function createLiveConnection(params) {
	let closeResolved = false;
	let resolveClosePromise = (_reason) => {};
	const closePromise = new Promise((resolve) => {
		resolveClosePromise = (reason) => {
			if (closeResolved) return;
			closeResolved = true;
			resolve(reason);
		};
	});
	return {
		connectionId: params.connectionId,
		startedAt: Date.now(),
		sock: params.sock,
		listener: params.listener,
		heartbeat: null,
		watchdogTimer: null,
		lastInboundAt: null,
		lastTransportActivityAt: Date.now(),
		handledMessages: 0,
		unregisterUnhandled: null,
		unregisterTransportActivity: null,
		openedAfterRecentInbound: params.openedAfterRecentInbound,
		backgroundTasks: /* @__PURE__ */ new Set(),
		closePromise,
		resolveClose: resolveClosePromise
	};
}
function closeWaSocket(sock) {
	try {
		if (typeof sock?.end === "function") {
			sock.end(/* @__PURE__ */ new Error("OpenClaw WhatsApp socket close"));
			return;
		}
		sock?.ws?.close?.();
	} catch {}
}
function closeWaSocketSoon(sock, delayMs = 500) {
	setTimeout(() => {
		closeWaSocket(sock);
	}, delayMs);
}
async function waitForWhatsAppLoginResult(params) {
	const wait = params.waitForConnection ?? waitForWaConnection;
	const createSocket = params.createSocket ?? createWaSocket;
	let currentSock = params.sock;
	let restarted = false;
	while (true) try {
		await wait(currentSock);
		return {
			outcome: "connected",
			restarted,
			sock: currentSock
		};
	} catch (err) {
		const statusCode = getStatusCode(err);
		if (statusCode === 515 && !restarted) {
			restarted = true;
			params.runtime.log(info(WHATSAPP_LOGIN_RESTART_MESSAGE));
			closeWaSocket(currentSock);
			try {
				currentSock = await createSocket(false, params.verbose, {
					authDir: params.authDir,
					...params.socketTiming,
					onQr: params.onQr
				});
				params.onSocketReplaced?.(currentSock);
				continue;
			} catch (createErr) {
				return {
					outcome: "failed",
					message: formatError(createErr),
					statusCode: getStatusCode(createErr),
					error: createErr
				};
			}
		}
		if (statusCode === LOGGED_OUT_STATUS) {
			await logoutWeb({
				authDir: params.authDir,
				isLegacyAuthDir: params.isLegacyAuthDir,
				runtime: params.runtime
			});
			return {
				outcome: "logged-out",
				message: WHATSAPP_LOGGED_OUT_RELINK_MESSAGE,
				statusCode: LOGGED_OUT_STATUS,
				error: err
			};
		}
		return {
			outcome: "failed",
			message: formatError(err),
			statusCode,
			error: err
		};
	}
}
var WhatsAppConnectionController = class {
	constructor(params) {
		this.disconnectRetryController = new AbortController();
		this.current = null;
		this.reconnectAttempts = 0;
		this.lastHandledInboundAt = null;
		this.accountId = params.accountId;
		this.authDir = params.authDir;
		this.verbose = params.verbose;
		this.keepAlive = params.keepAlive;
		this.heartbeatSeconds = params.heartbeatSeconds;
		this.transportTimeoutMs = params.transportTimeoutMs;
		this.messageTimeoutMs = params.messageTimeoutMs;
		this.appSilenceTimeoutMs = Math.max(params.messageTimeoutMs, params.messageTimeoutMs * 4);
		this.watchdogCheckMs = params.watchdogCheckMs;
		this.reconnectPolicy = params.reconnectPolicy;
		this.abortSignal = params.abortSignal;
		this.sleep = params.sleep ?? ((ms, signal) => sleepWithAbort(ms, signal));
		this.isNonRetryableStatus = params.isNonRetryableStatus ?? (() => false);
		this.socketTiming = params.socketTiming ?? {};
		this.socketRef = { current: null };
		this.abortPromise = params.abortSignal && new Promise((resolve) => {
			params.abortSignal?.addEventListener("abort", () => resolve("aborted"), { once: true });
		});
		if (params.abortSignal?.aborted) this.stopDisconnectRetries();
		else params.abortSignal?.addEventListener("abort", () => this.stopDisconnectRetries(), { once: true });
	}
	getActiveListener() {
		return this.current?.listener ?? null;
	}
	getReconnectAttempts() {
		return this.reconnectAttempts;
	}
	isStopRequested() {
		return this.abortSignal?.aborted === true;
	}
	shouldRetryDisconnect() {
		return this.keepAlive && !this.isStopRequested() && !this.disconnectRetryController.signal.aborted;
	}
	getDisconnectRetryAbortSignal() {
		return this.disconnectRetryController.signal;
	}
	noteInbound(timestamp = Date.now()) {
		if (!this.current) return;
		this.current.handledMessages += 1;
		this.current.lastInboundAt = timestamp;
		this.current.lastTransportActivityAt = timestamp;
		this.current.openedAfterRecentInbound = false;
		this.lastHandledInboundAt = timestamp;
	}
	noteTransportActivity(timestamp = Date.now()) {
		if (!this.current) return;
		this.current.lastTransportActivityAt = timestamp;
	}
	getCurrentSnapshot(connection = this.current) {
		if (!connection) return null;
		return {
			connectionId: connection.connectionId,
			startedAt: connection.startedAt,
			lastInboundAt: connection.lastInboundAt,
			lastTransportActivityAt: connection.lastTransportActivityAt,
			handledMessages: connection.handledMessages,
			reconnectAttempts: this.reconnectAttempts,
			uptimeMs: Date.now() - connection.startedAt
		};
	}
	setUnhandledRejectionCleanup(unregister) {
		if (!this.current) {
			unregister?.();
			return;
		}
		this.current.unregisterUnhandled?.();
		this.current.unregisterUnhandled = unregister;
	}
	async openConnection(params) {
		if (this.current) await this.closeCurrentConnection();
		let sock = null;
		let connection = null;
		try {
			sock = await createWaSocket(false, this.verbose, {
				authDir: this.authDir,
				...this.socketTiming
			});
			await waitForWaConnection(sock);
			this.socketRef.current = sock;
			connection = createLiveConnection({
				connectionId: params.connectionId,
				sock,
				listener: {},
				openedAfterRecentInbound: this.isOpeningAfterRecentInbound()
			});
			const listener = await params.createListener({
				sock,
				connection
			});
			connection.listener = listener;
			this.current = connection;
			connection.unregisterTransportActivity = this.attachTransportActivityListener(sock);
			registerWhatsAppConnectionController(this.accountId, this);
			this.startTimers(connection, {
				onHeartbeat: params.onHeartbeat,
				onWatchdogTimeout: params.onWatchdogTimeout
			});
			return connection;
		} catch (err) {
			if (this.socketRef.current === sock) this.socketRef.current = null;
			closeWaSocket(sock);
			if (connection?.unregisterUnhandled) connection.unregisterUnhandled();
			connection?.unregisterTransportActivity?.();
			throw err;
		}
	}
	async waitForClose() {
		const connection = this.current;
		if (!connection) return "aborted";
		const listenerClose = connection.listener.onClose?.catch((err) => ({
			status: 500,
			isLoggedOut: false,
			error: err
		})) ?? createNeverResolvePromise();
		return await Promise.race([
			connection.closePromise,
			listenerClose,
			this.abortPromise ?? createNeverResolvePromise()
		]);
	}
	normalizeCloseReason(reason) {
		const statusCode = (typeof reason === "object" && reason && "status" in reason ? reason.status : void 0) ?? void 0;
		return {
			statusCode,
			statusLabel: typeof statusCode === "number" ? statusCode : "unknown",
			isLoggedOut: typeof reason === "object" && reason !== null && "isLoggedOut" in reason && reason.isLoggedOut === true,
			error: reason?.error,
			errorText: formatError(reason)
		};
	}
	resolveCloseDecision(reason) {
		if (reason === "aborted" || this.isStopRequested()) return "aborted";
		const current = this.current;
		if (current && Date.now() - current.startedAt > this.heartbeatSeconds * 1e3) this.reconnectAttempts = 0;
		const normalized = this.normalizeCloseReason(reason);
		if (normalized.isLoggedOut) return {
			action: "stop",
			reconnectAttempts: this.reconnectAttempts,
			healthState: "logged-out",
			normalized
		};
		if (this.isNonRetryableStatus(normalized.statusCode)) return {
			action: "stop",
			reconnectAttempts: this.reconnectAttempts,
			healthState: "conflict",
			normalized
		};
		const retryDecision = this.consumeReconnectAttempt();
		if (retryDecision.action === "stop") return {
			action: "stop",
			reconnectAttempts: retryDecision.reconnectAttempts,
			healthState: retryDecision.healthState,
			normalized
		};
		return {
			action: "retry",
			delayMs: retryDecision.delayMs,
			reconnectAttempts: retryDecision.reconnectAttempts,
			healthState: retryDecision.healthState,
			normalized
		};
	}
	consumeReconnectAttempt() {
		this.reconnectAttempts += 1;
		if (this.reconnectPolicy.maxAttempts > 0 && this.reconnectAttempts >= this.reconnectPolicy.maxAttempts) return {
			action: "stop",
			reconnectAttempts: this.reconnectAttempts,
			healthState: "stopped"
		};
		return {
			action: "retry",
			delayMs: computeBackoff(this.reconnectPolicy, this.reconnectAttempts),
			reconnectAttempts: this.reconnectAttempts,
			healthState: "reconnecting"
		};
	}
	forceClose(reason) {
		const connection = this.current;
		if (!connection) return;
		connection.resolveClose(reason);
		connection.listener.signalClose?.(reason);
	}
	async closeCurrentConnection() {
		const connection = this.current;
		if (!connection) return;
		this.current = null;
		if (this.socketRef.current === connection.sock) this.socketRef.current = null;
		connection.unregisterUnhandled?.();
		connection.unregisterTransportActivity?.();
		if (connection.heartbeat) clearInterval(connection.heartbeat);
		if (connection.watchdogTimer) clearInterval(connection.watchdogTimer);
		if (connection.backgroundTasks.size > 0) {
			await Promise.allSettled(connection.backgroundTasks);
			connection.backgroundTasks.clear();
		}
		try {
			await connection.listener.close?.();
		} catch {}
		closeWaSocket(connection.sock);
	}
	async waitBeforeRetry(delayMs) {
		await this.sleep(delayMs, this.abortSignal);
	}
	async shutdown() {
		this.stopDisconnectRetries();
		await this.closeCurrentConnection();
		unregisterWhatsAppConnectionController(this.accountId, this);
	}
	startTimers(connection, hooks) {
		if (!this.keepAlive) return;
		connection.heartbeat = setInterval(() => {
			const snapshot = this.getCurrentSnapshot(connection);
			if (!snapshot) return;
			hooks.onHeartbeat?.(snapshot);
		}, this.heartbeatSeconds * 1e3);
		connection.watchdogTimer = setInterval(() => {
			const now = Date.now();
			const transportStaleForMs = now - connection.lastTransportActivityAt;
			const appSilentForMs = now - (connection.lastInboundAt ?? connection.startedAt);
			const appSilenceTimeoutMs = connection.openedAfterRecentInbound ? this.messageTimeoutMs : this.appSilenceTimeoutMs;
			if (transportStaleForMs <= this.transportTimeoutMs && appSilentForMs <= appSilenceTimeoutMs) return;
			const snapshot = this.getCurrentSnapshot(connection);
			if (!snapshot) return;
			hooks.onWatchdogTimeout?.(snapshot);
			this.forceClose({
				status: 499,
				isLoggedOut: false,
				error: "watchdog-timeout"
			});
		}, this.watchdogCheckMs);
	}
	attachTransportActivityListener(sock) {
		const ws = sock.ws;
		if (!ws || typeof ws.on !== "function") return null;
		const noteActivity = () => this.noteTransportActivity();
		ws.on("frame", noteActivity);
		return () => {
			if (typeof ws.off === "function") {
				ws.off("frame", noteActivity);
				return;
			}
			ws.removeListener?.("frame", noteActivity);
		};
	}
	isOpeningAfterRecentInbound() {
		if (this.reconnectAttempts <= 0 || this.lastHandledInboundAt === null) return false;
		return Date.now() - this.lastHandledInboundAt <= this.appSilenceTimeoutMs;
	}
	stopDisconnectRetries() {
		if (!this.disconnectRetryController.signal.aborted) this.disconnectRetryController.abort();
	}
};
//#endregion
export { waitForWhatsAppLoginResult as a, resolveHeartbeatSeconds as c, closeWaSocketSoon as i, resolveReconnectPolicy as l, WhatsAppConnectionController as n, DEFAULT_RECONNECT_POLICY as o, closeWaSocket as r, newConnectionId as s, WHATSAPP_LOGGED_OUT_QR_MESSAGE as t };
