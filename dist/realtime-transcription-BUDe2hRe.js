import { n as createDebugProxyWebSocketAgent, r as resolveDebugProxySettings } from "./env-CDrl0Kuj.js";
import { n as captureWsEvent } from "./runtime-Cqhsh14m.js";
import "./provider-registry-DpzahkXi.js";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
//#region src/realtime-transcription/websocket-session.ts
const DEFAULT_CONNECT_TIMEOUT_MS = 1e4;
const DEFAULT_CLOSE_TIMEOUT_MS = 5e3;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_RECONNECT_DELAY_MS = 1e3;
const DEFAULT_MAX_QUEUED_BYTES = 2 * 1024 * 1024;
function rawWsDataToBuffer(data) {
	if (Buffer.isBuffer(data)) return data;
	if (Array.isArray(data)) return Buffer.concat(data);
	return Buffer.from(data);
}
function defaultParseMessage(payload) {
	try {
		return JSON.parse(payload.toString());
	} catch {
		throw new Error("Realtime transcription websocket received malformed JSON.");
	}
}
var WebSocketRealtimeTranscriptionSession = class {
	constructor(options) {
		this.closed = false;
		this.connected = false;
		this.currentUrl = "";
		this.queuedAudio = [];
		this.queuedBytes = 0;
		this.ready = false;
		this.reconnectAttempts = 0;
		this.reconnecting = false;
		this.suppressReconnect = false;
		this.ws = null;
		this.flowId = randomUUID();
		this.options = options;
		this.transport = {
			callbacks: options.callbacks,
			closeNow: () => {
				this.closed = true;
				this.forceClose();
			},
			failConnect: (error) => this.failConnect?.(error),
			isOpen: () => this.ws?.readyState === WebSocket.OPEN,
			isReady: () => this.ready,
			markReady: () => this.markReady?.(),
			sendBinary: (payload) => this.sendBinary(payload),
			sendJson: (payload) => this.sendJson(payload)
		};
	}
	async connect() {
		this.closed = false;
		this.suppressReconnect = false;
		this.reconnectAttempts = 0;
		await this.doConnect();
	}
	sendAudio(audio) {
		if (this.closed || audio.byteLength === 0) return;
		if (this.ws?.readyState === WebSocket.OPEN && this.ready) {
			this.options.sendAudio(audio, this.transport);
			return;
		}
		this.queueAudio(audio);
	}
	close() {
		this.closed = true;
		this.connected = false;
		this.ready = false;
		this.queuedAudio = [];
		this.queuedBytes = 0;
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			this.forceClose();
			return;
		}
		try {
			this.options.onClose?.(this.transport);
		} catch (error) {
			this.emitError(error);
		}
		this.closeTimer = setTimeout(() => this.forceClose(), this.closeTimeoutMs);
	}
	isConnected() {
		return this.connected && this.ready;
	}
	get closeTimeoutMs() {
		return this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
	}
	get connectTimeoutMs() {
		return this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	}
	get maxQueuedBytes() {
		return this.options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
	}
	get maxReconnectAttempts() {
		return this.options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
	}
	get reconnectDelayMs() {
		return this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
	}
	async doConnect() {
		await new Promise((resolve, reject) => {
			this.ready = false;
			const proxyAgent = createDebugProxyWebSocketAgent(resolveDebugProxySettings());
			let settled = false;
			let opened = false;
			let connectTimeout;
			const normalizeError = (error) => error instanceof Error ? error : new Error(String(error));
			const clearConnectTimeout = () => {
				if (connectTimeout) {
					clearTimeout(connectTimeout);
					connectTimeout = void 0;
				}
			};
			const finishClosedConnect = () => {
				if (settled) return;
				settled = true;
				clearConnectTimeout();
				resolve();
			};
			const finishConnect = () => {
				if (settled) return;
				settled = true;
				clearConnectTimeout();
				this.ready = true;
				this.flushQueuedAudio();
				resolve();
			};
			const failConnect = (error) => {
				if (settled) return;
				settled = true;
				clearConnectTimeout();
				this.emitError(error);
				this.suppressReconnect = true;
				this.forceClose();
				reject(error);
			};
			this.markReady = finishConnect;
			this.failConnect = failConnect;
			connectTimeout = setTimeout(() => {
				failConnect(new Error(this.options.connectTimeoutMessage ?? `${this.options.providerId} realtime transcription connection timeout`));
			}, this.connectTimeoutMs);
			(async () => {
				let connection;
				try {
					connection = await this.resolveConnection();
				} catch (error) {
					failConnect(normalizeError(error));
					return;
				}
				if (settled) return;
				if (this.closed) {
					finishClosedConnect();
					return;
				}
				this.currentUrl = connection.url;
				try {
					this.ws = new WebSocket(this.currentUrl, {
						headers: connection.headers,
						...proxyAgent ? { agent: proxyAgent } : {}
					});
				} catch (error) {
					failConnect(normalizeError(error));
					return;
				}
				this.ws.on("open", () => {
					opened = true;
					this.connected = true;
					this.reconnectAttempts = 0;
					this.captureLocalOpen();
					try {
						this.options.onOpen?.(this.transport);
						if (this.options.readyOnOpen) finishConnect();
					} catch (error) {
						failConnect(normalizeError(error));
					}
				});
				this.ws.on("message", (data) => {
					const payload = rawWsDataToBuffer(data);
					this.captureFrame("inbound", payload);
					try {
						if (!this.options.onMessage) return;
						const parseMessage = this.options.parseMessage ?? defaultParseMessage;
						this.options.onMessage(parseMessage(payload), this.transport);
					} catch (error) {
						this.emitError(error);
					}
				});
				this.ws.on("error", (error) => {
					const normalized = normalizeError(error);
					this.captureError(normalized);
					if (!opened || !settled) {
						failConnect(normalized);
						return;
					}
					this.emitError(normalized);
				});
				this.ws.on("close", (code, reasonBuffer) => {
					clearConnectTimeout();
					this.captureClose(code, reasonBuffer);
					this.connected = false;
					this.ready = false;
					if (this.closeTimer) {
						clearTimeout(this.closeTimer);
						this.closeTimer = void 0;
					}
					if (this.closed) return;
					if (this.suppressReconnect) {
						this.suppressReconnect = false;
						return;
					}
					if (!opened || !settled) {
						failConnect(new Error(this.options.connectClosedBeforeReadyMessage ?? `${this.options.providerId} realtime transcription connection closed before ready`));
						return;
					}
					this.attemptReconnect();
				});
			})();
		});
	}
	async resolveConnection() {
		return {
			url: await (typeof this.options.url === "function" ? this.options.url() : this.options.url),
			headers: await (typeof this.options.headers === "function" ? this.options.headers() : this.options.headers)
		};
	}
	async attemptReconnect() {
		if (this.closed || this.reconnecting) return;
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			this.emitError(new Error(this.options.reconnectLimitMessage ?? `${this.options.providerId} realtime transcription reconnect limit reached`));
			return;
		}
		this.reconnectAttempts += 1;
		const delay = this.reconnectDelayMs * 2 ** (this.reconnectAttempts - 1);
		this.reconnecting = true;
		try {
			await new Promise((resolve) => setTimeout(resolve, delay));
			if (!this.closed) await this.doConnect();
		} catch {
			if (!this.closed) {
				this.reconnecting = false;
				await this.attemptReconnect();
				return;
			}
		} finally {
			this.reconnecting = false;
		}
	}
	queueAudio(audio) {
		this.queuedAudio.push(Buffer.from(audio));
		this.queuedBytes += audio.byteLength;
		while (this.queuedBytes > this.maxQueuedBytes && this.queuedAudio.length > 0) {
			const dropped = this.queuedAudio.shift();
			this.queuedBytes -= dropped?.byteLength ?? 0;
		}
	}
	flushQueuedAudio() {
		for (const audio of this.queuedAudio) this.options.sendAudio(audio, this.transport);
		this.queuedAudio = [];
		this.queuedBytes = 0;
	}
	sendBinary(payload) {
		if (this.ws?.readyState !== WebSocket.OPEN) return false;
		this.captureFrame("outbound", payload);
		this.ws.send(payload);
		return true;
	}
	sendJson(payload) {
		if (this.ws?.readyState !== WebSocket.OPEN) return false;
		const serialized = JSON.stringify(payload);
		this.captureFrame("outbound", serialized);
		this.ws.send(serialized);
		return true;
	}
	forceClose() {
		if (this.closeTimer) {
			clearTimeout(this.closeTimer);
			this.closeTimer = void 0;
		}
		this.connected = false;
		this.ready = false;
		if (this.ws) {
			this.ws.close(1e3, "Transcription session closed");
			this.ws = null;
		}
	}
	emitError(error) {
		this.options.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
	}
	captureFrame(direction, payload) {
		captureWsEvent({
			url: this.currentUrl,
			direction,
			kind: "ws-frame",
			flowId: this.flowId,
			payload,
			meta: {
				provider: this.options.providerId,
				capability: "realtime-transcription"
			}
		});
	}
	captureLocalOpen() {
		captureWsEvent({
			url: this.currentUrl,
			direction: "local",
			kind: "ws-open",
			flowId: this.flowId,
			meta: {
				provider: this.options.providerId,
				capability: "realtime-transcription"
			}
		});
	}
	captureError(error) {
		captureWsEvent({
			url: this.currentUrl,
			direction: "local",
			kind: "error",
			flowId: this.flowId,
			errorText: error.message,
			meta: {
				provider: this.options.providerId,
				capability: "realtime-transcription"
			}
		});
	}
	captureClose(code, reasonBuffer) {
		captureWsEvent({
			url: this.currentUrl,
			direction: "local",
			kind: "ws-close",
			flowId: this.flowId,
			closeCode: code,
			meta: {
				provider: this.options.providerId,
				capability: "realtime-transcription",
				reason: reasonBuffer.length > 0 ? reasonBuffer.toString("utf8") : void 0
			}
		});
	}
};
function createRealtimeTranscriptionWebSocketSession(options) {
	return new WebSocketRealtimeTranscriptionSession(options);
}
//#endregion
export { createRealtimeTranscriptionWebSocketSession as t };
