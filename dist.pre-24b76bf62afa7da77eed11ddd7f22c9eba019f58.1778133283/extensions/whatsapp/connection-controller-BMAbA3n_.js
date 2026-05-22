import { t as formatCliCommand } from "../../command-format-ut6bcRZg.js";
import { n as clamp, p as resolveUserPath, s as ensureDir } from "../../utils-D5swhEXt.js";
import { n as VERSION } from "../../version-DdTF4eka.js";
import { i as getChildLogger, u as toPinoLikeLogger } from "../../logger-CQ0p51p4.js";
import { n as info, o as success, t as danger } from "../../globals-BHVmraBM.js";
import { c as shouldUseEnvHttpProxyForUrl, s as resolveEnvHttpProxyUrl } from "../../proxy-env-CSSpFHDS.js";
import { n as sleepWithAbort, t as computeBackoff } from "../../backoff-DJG4TwNq.js";
import "../../text-runtime-DCigKjjg.js";
import "../../runtime-env-DVyvKnep.js";
import "../../media-runtime-B3sgGdPE.js";
import { t as renderQrTerminal } from "../../qr-terminal-BFuoJlbD.js";
import "../../cli-runtime-C4FY6iMu.js";
import "../../fetch-runtime-DLwIeNNc.js";
import { n as resolveWebCredsBackupPath, r as resolveWebCredsPath } from "./creds-files-DrQobVxz.js";
import { n as registerWhatsAppConnectionController, r as unregisterWhatsAppConnectionController } from "./connection-controller-registry-C5LCHZRH.js";
import { n as getStatusCode, t as formatError } from "./session-errors-BQATnxTz.js";
import { C as waitForCredsSaveQueueWithTimeout, l as readCredsJsonRaw, s as logoutWeb, v as resolveDefaultWebAuthDir, w as writeCredsJsonAtomically, x as enqueueCredsSave, y as restoreCredsFromBackupIfNeeded } from "./auth-store-C2C0dMot.js";
import { d as DisconnectReason, l as fetchLatestBaileysVersion, n as useMultiFileAuthState, r as makeCacheableSignalKeyStore, t as makeWASocket } from "./session.runtime-mqUet1Wv.js";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { HttpsProxyAgent } from "https-proxy-agent";
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
function newConnectionId$1() {
	return randomUUID();
}
//#endregion
//#region extensions/whatsapp/src/socket-timing.ts
const DEFAULT_WHATSAPP_SOCKET_TIMING = {
	keepAliveIntervalMs: 25e3,
	connectTimeoutMs: 6e4,
	defaultQueryTimeoutMs: 6e4
};
function positiveInteger(value) {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : void 0;
}
function resolveWhatsAppSocketTiming(cfg, overrides) {
	const configured = cfg.web?.whatsapp;
	return {
		keepAliveIntervalMs: positiveInteger(overrides?.keepAliveIntervalMs) ?? positiveInteger(configured?.keepAliveIntervalMs) ?? DEFAULT_WHATSAPP_SOCKET_TIMING.keepAliveIntervalMs,
		connectTimeoutMs: positiveInteger(overrides?.connectTimeoutMs) ?? positiveInteger(configured?.connectTimeoutMs) ?? DEFAULT_WHATSAPP_SOCKET_TIMING.connectTimeoutMs,
		defaultQueryTimeoutMs: positiveInteger(overrides?.defaultQueryTimeoutMs) ?? positiveInteger(configured?.defaultQueryTimeoutMs) ?? DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs
	};
}
//#endregion
//#region extensions/whatsapp/src/session.ts
const LOGGED_OUT_STATUS$1 = DisconnectReason?.loggedOut ?? 401;
const WHATSAPP_WEBSOCKET_PROXY_TARGET = "https://mmg.whatsapp.net/";
const CREDS_FLUSH_TIMEOUT_MESSAGE = "Queued WhatsApp creds save did not finish before auth bootstrap; skipping repair and continuing with primary creds.";
function enqueueSaveCreds(authDir, saveCreds, logger) {
	enqueueCredsSave(authDir, () => safeSaveCreds(authDir, saveCreds, logger), (err) => {
		logger.warn({ error: String(err) }, "WhatsApp creds save queue error");
	});
}
async function safeSaveCreds(authDir, saveCreds, logger) {
	try {
		const credsPath = resolveWebCredsPath(authDir);
		const backupPath = resolveWebCredsBackupPath(authDir);
		const raw = readCredsJsonRaw(credsPath);
		if (raw) try {
			JSON.parse(raw);
			fs.copyFileSync(credsPath, backupPath);
			try {
				fs.chmodSync(backupPath, 384);
			} catch {}
		} catch {}
	} catch {}
	try {
		await Promise.resolve(saveCreds());
	} catch (err) {
		logger.warn({ error: String(err) }, "failed saving WhatsApp creds");
	}
}
async function printTerminalQr(qr) {
	const output = await renderQrTerminal(qr, { small: true });
	process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}
/**
* Create a Baileys socket backed by the multi-file auth store we keep on disk.
* Consumers can opt into QR printing for interactive login flows.
*/
async function createWaSocket(printQr, verbose, opts = {}) {
	const logger = toPinoLikeLogger(getChildLogger({ module: "baileys" }, { level: verbose ? "info" : "silent" }), verbose ? "info" : "silent");
	const authDir = resolveUserPath(opts.authDir ?? resolveDefaultWebAuthDir());
	await ensureDir(authDir);
	const sessionLogger = getChildLogger({ module: "web-session" });
	if (await waitForCredsSaveQueueWithTimeout(authDir) === "timed_out") sessionLogger.warn({ authDir }, CREDS_FLUSH_TIMEOUT_MESSAGE);
	else await restoreCredsFromBackupIfNeeded(authDir);
	const { state } = await useMultiFileAuthState(authDir);
	const saveCreds = async () => {
		await writeCredsJsonAtomically(authDir, state.creds);
	};
	const { version } = await fetchLatestBaileysVersion();
	const agent = await resolveEnvProxyAgent(sessionLogger);
	const fetchAgent = await resolveEnvFetchDispatcher(sessionLogger, agent);
	const socketTiming = {
		keepAliveIntervalMs: opts.keepAliveIntervalMs ?? DEFAULT_WHATSAPP_SOCKET_TIMING.keepAliveIntervalMs,
		connectTimeoutMs: opts.connectTimeoutMs ?? DEFAULT_WHATSAPP_SOCKET_TIMING.connectTimeoutMs,
		defaultQueryTimeoutMs: opts.defaultQueryTimeoutMs ?? DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs
	};
	const sock = makeWASocket({
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger)
		},
		version,
		logger,
		printQRInTerminal: false,
		browser: [
			"openclaw",
			"cli",
			VERSION
		],
		syncFullHistory: false,
		markOnlineOnConnect: false,
		...socketTiming,
		agent,
		fetchAgent
	});
	sock.ev.on("creds.update", () => enqueueSaveCreds(authDir, saveCreds, sessionLogger));
	sock.ev.on("connection.update", async (update) => {
		try {
			const { connection, lastDisconnect, qr } = update;
			if (qr) {
				opts.onQr?.(qr);
				if (printQr) {
					console.log("Open the WhatsApp app, go to Linked Devices, then scan this QR:");
					printTerminalQr(qr).catch((err) => {
						sessionLogger.warn({ error: String(err) }, "failed rendering WhatsApp QR");
					});
				}
			}
			if (connection === "close") {
				if (getStatusCode(lastDisconnect?.error) === LOGGED_OUT_STATUS$1) console.error(danger(`WhatsApp session logged out. Run: ${formatCliCommand("openclaw channels login")}`));
			}
			if (connection === "open" && verbose) console.log(success("WhatsApp Web connected."));
		} catch (err) {
			sessionLogger.error({ error: String(err) }, "connection.update handler error");
		}
	});
	if (sock.ws && typeof sock.ws.on === "function") sock.ws.on("error", (err) => {
		sessionLogger.error({ error: String(err) }, "WebSocket error");
	});
	return sock;
}
async function resolveEnvProxyAgent(logger) {
	if (!shouldUseEnvHttpProxyForUrl(WHATSAPP_WEBSOCKET_PROXY_TARGET)) return;
	const proxyUrl = resolveEnvHttpProxyUrl("https");
	if (!proxyUrl) return;
	try {
		const agent = new HttpsProxyAgent(proxyUrl);
		logger.info("Using ambient env proxy for WhatsApp WebSocket connection");
		return agent;
	} catch (error) {
		logger.warn({ error: String(error) }, "Failed to initialize env proxy agent for WhatsApp WebSocket connection");
		return;
	}
}
async function resolveEnvFetchDispatcher(logger, agent) {
	const proxyUrl = resolveProxyUrlFromAgent(agent);
	const envProxyUrl = resolveEnvHttpsProxyUrl();
	if (!proxyUrl && !envProxyUrl) return;
	try {
		const { EnvHttpProxyAgent, ProxyAgent } = await import("undici");
		return proxyUrl ? new ProxyAgent({
			allowH2: false,
			uri: proxyUrl
		}) : new EnvHttpProxyAgent({ allowH2: false });
	} catch (error) {
		logger.warn({ error: String(error) }, "Failed to initialize env proxy dispatcher for WhatsApp media uploads");
		return;
	}
}
function resolveProxyUrlFromAgent(agent) {
	if (typeof agent !== "object" || agent === null || !("proxy" in agent)) return;
	const proxy = agent.proxy;
	if (proxy instanceof URL) return proxy.toString();
	return typeof proxy === "string" && proxy.length > 0 ? proxy : void 0;
}
function resolveEnvHttpsProxyUrl(env = process.env) {
	const lowerHttpsProxy = normalizeEnvProxyValue(env.https_proxy);
	const lowerHttpProxy = normalizeEnvProxyValue(env.http_proxy);
	const httpsProxy = lowerHttpsProxy !== void 0 ? lowerHttpsProxy : normalizeEnvProxyValue(env.HTTPS_PROXY);
	const httpProxy = lowerHttpProxy !== void 0 ? lowerHttpProxy : normalizeEnvProxyValue(env.HTTP_PROXY);
	return httpsProxy ?? httpProxy ?? void 0;
}
function normalizeEnvProxyValue(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}
async function waitForWaConnection(sock) {
	return new Promise((resolve, reject) => {
		const evWithOff = sock.ev;
		const handler = (...args) => {
			const update = args[0] ?? {};
			if (update.connection === "open") {
				evWithOff.off?.("connection.update", handler);
				resolve();
			}
			if (update.connection === "close") {
				evWithOff.off?.("connection.update", handler);
				reject(update.lastDisconnect ?? /* @__PURE__ */ new Error("Connection closed"));
			}
		};
		sock.ev.on("connection.update", handler);
	});
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
export { waitForWhatsAppLoginResult as a, waitForWaConnection as c, newConnectionId$1 as d, resolveHeartbeatSeconds as f, closeWaSocketSoon as i, resolveWhatsAppSocketTiming as l, WhatsAppConnectionController as n, createWaSocket as o, resolveReconnectPolicy as p, closeWaSocket as r, newConnectionId as s, WHATSAPP_LOGGED_OUT_QR_MESSAGE as t, DEFAULT_RECONNECT_POLICY as u };
