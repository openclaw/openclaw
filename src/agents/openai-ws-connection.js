import { randomUUID } from "node:crypto";
/**
 * OpenAI WebSocket Connection Manager
 *
 * Manages a persistent WebSocket connection to the OpenAI Responses API
 * (wss://api.openai.com/v1/responses) for multi-turn tool-call workflows.
 *
 * Features:
 * - Auto-reconnect with exponential backoff (max 5 retries: 1s/2s/4s/8s/16s)
 * - Tracks previous_response_id per connection for incremental turns
 * - Warm-up support (generate: false) to pre-load the connection
 * - Typed WebSocket event definitions matching the Responses API SSE spec
 *
 * @see https://developers.openai.com/api/docs/guides/websocket-mode
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { rawDataToString } from "../infra/ws.js";
import { createDebugProxyWebSocketAgent, resolveDebugProxySettings } from "../proxy-capture/env.js";
import { captureWsEvent } from "../proxy-capture/runtime.js";
import { buildOpenAIWebSocketWarmUpPayload } from "./openai-ws-request.js";
import { buildProviderRequestTlsClientOptions, resolveProviderRequestPolicyConfig, } from "./provider-request-config.js";
// ─────────────────────────────────────────────────────────────────────────────
// Connection Manager
// ─────────────────────────────────────────────────────────────────────────────
const OPENAI_WS_URL = "wss://api.openai.com/v1/responses";
const MAX_RETRIES = 5;
/** Backoff delays in ms: 1s, 2s, 4s, 8s, 16s */
const BACKOFF_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
/**
 * Manages a persistent WebSocket connection to the OpenAI Responses API.
 *
 * Usage:
 * ```ts
 * const manager = new OpenAIWebSocketManager();
 * await manager.connect(apiKey);
 *
 * manager.onMessage((event) => {
 *   if (event.type === "response.completed") {
 *     console.log("Response ID:", event.response.id);
 *   }
 * });
 *
 * manager.send({ type: "response.create", model: "gpt-5.4", input: [...] });
 * ```
 */
export class OpenAIWebSocketManager extends EventEmitter {
    ws = null;
    apiKey = null;
    retryCount = 0;
    retryTimer = null;
    closed = false;
    /** The ID of the most recent completed response on this connection. */
    _previousResponseId = null;
    _connectionState = "idle";
    _lastCloseInfo = null;
    wsUrl;
    maxRetries;
    backoffDelaysMs;
    socketFactory;
    headers;
    request;
    flowId;
    constructor(options = {}) {
        super();
        this.wsUrl = options.url ?? OPENAI_WS_URL;
        this.maxRetries = options.maxRetries ?? MAX_RETRIES;
        this.backoffDelaysMs = options.backoffDelaysMs ?? BACKOFF_DELAYS_MS;
        this.socketFactory =
            options.socketFactory ?? ((url, socketOptions) => new WebSocket(url, socketOptions));
        this.headers = options.headers;
        this.request = options.request;
        this.flowId = randomUUID();
    }
    // ─── Public API ────────────────────────────────────────────────────────────
    /**
     * Returns the previous_response_id from the last completed response,
     * for use in subsequent response.create events.
     */
    get previousResponseId() {
        return this._previousResponseId;
    }
    get connectionState() {
        return this._connectionState;
    }
    get lastCloseInfo() {
        return this._lastCloseInfo;
    }
    /**
     * Opens a WebSocket connection to the OpenAI Responses API.
     * Resolves when the connection is established (open event fires).
     * Rejects if the initial connection fails after max retries.
     */
    connect(apiKey) {
        this.apiKey = apiKey;
        this.closed = false;
        this.retryCount = 0;
        this._connectionState = "connecting";
        this._lastCloseInfo = null;
        return this._openConnection();
    }
    /**
     * Sends a typed event to the OpenAI Responses API over the WebSocket.
     * Throws if the connection is not open.
     */
    send(event) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error(`OpenAIWebSocketManager: cannot send — connection is not open (readyState=${this.ws?.readyState ?? "no socket"})`);
        }
        const payload = JSON.stringify(event);
        captureWsEvent({
            url: this.wsUrl,
            direction: "outbound",
            kind: "ws-frame",
            flowId: this.flowId,
            payload,
            meta: { eventType: event.type },
        });
        this.ws.send(payload);
    }
    /**
     * Registers a handler for incoming server-sent WebSocket events.
     * Returns an unsubscribe function.
     */
    onMessage(handler) {
        this.on("message", handler);
        return () => {
            this.off("message", handler);
        };
    }
    /**
     * Returns true if the WebSocket is currently open and ready to send.
     */
    isConnected() {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }
    /**
     * Permanently closes the WebSocket connection and disables auto-reconnect.
     */
    close() {
        this.closed = true;
        this._connectionState = "closed";
        this._cancelRetryTimer();
        if (this.ws) {
            this.ws.removeAllListeners();
            try {
                if (this.ws.readyState === WebSocket.OPEN) {
                    this.ws.close(1000, "Client closed");
                }
                else if (this.ws.readyState === WebSocket.CONNECTING) {
                    // ws can still throw here while the handshake is in-flight.
                    this.ws.terminate();
                }
            }
            catch {
                // Best-effort close during setup/teardown.
            }
            this.ws = null;
        }
    }
    // ─── Internal: Connection Lifecycle ────────────────────────────────────────
    _openConnection() {
        return new Promise((resolve, reject) => {
            if (!this.apiKey) {
                reject(new Error("OpenAIWebSocketManager: apiKey is required before connecting."));
                return;
            }
            const requestConfig = resolveProviderRequestPolicyConfig({
                provider: "openai",
                api: "openai-responses",
                baseUrl: this.wsUrl,
                capability: "llm",
                transport: "websocket",
                providerHeaders: {
                    Authorization: `Bearer ${this.apiKey}`,
                    "OpenAI-Beta": "responses-websocket=v1",
                    ...this.headers,
                },
                precedence: "defaults-win",
                request: this.request,
                allowPrivateNetwork: this.request?.allowPrivateNetwork === true,
            });
            const debugAgent = createDebugProxyWebSocketAgent(resolveDebugProxySettings());
            const socket = this.socketFactory(this.wsUrl, {
                headers: requestConfig.headers,
                ...(debugAgent ? { agent: debugAgent } : {}),
                ...buildProviderRequestTlsClientOptions(requestConfig),
            });
            this.ws = socket;
            const onOpen = () => {
                this.retryCount = 0;
                this._connectionState = "open";
                this._lastCloseInfo = null;
                captureWsEvent({
                    url: this.wsUrl,
                    direction: "local",
                    kind: "ws-open",
                    flowId: this.flowId,
                });
                resolve();
                this.emit("open");
            };
            const onError = (err) => {
                // Remove open listener so we don't resolve after an error.
                socket.off("open", onOpen);
                // Emit "error" on the manager only when there are listeners; otherwise
                // the promise rejection below is the primary error channel for this
                // initial connection failure. (An uncaught "error" event in Node.js
                // throws synchronously and would prevent the promise from rejecting.)
                if (this.listenerCount("error") > 0) {
                    this.emit("error", err);
                }
                captureWsEvent({
                    url: this.wsUrl,
                    direction: "local",
                    kind: "error",
                    flowId: this.flowId,
                    errorText: err.message,
                });
                if (this._connectionState === "connecting" || this._connectionState === "reconnecting") {
                    this._connectionState = "closed";
                }
                reject(err);
            };
            const onClose = (code, reason) => {
                const reasonStr = reason.toString();
                const closeInfo = {
                    code,
                    reason: reasonStr,
                    retryable: isRetryableWebSocketClose(code),
                };
                this._lastCloseInfo = closeInfo;
                captureWsEvent({
                    url: this.wsUrl,
                    direction: "local",
                    kind: "ws-close",
                    flowId: this.flowId,
                    closeCode: code,
                    payload: reasonStr,
                });
                this.emit("close", code, reasonStr);
                if (!this.closed && closeInfo.retryable) {
                    this._scheduleReconnect();
                }
                else {
                    this._connectionState = "closed";
                }
            };
            const onMessage = (data) => {
                captureWsEvent({
                    url: this.wsUrl,
                    direction: "inbound",
                    kind: "ws-frame",
                    flowId: this.flowId,
                    payload: Buffer.from(rawDataToString(data)),
                });
                this._handleMessage(data);
            };
            socket.once("open", onOpen);
            socket.on("error", onError);
            socket.on("close", onClose);
            socket.on("message", onMessage);
        });
    }
    _scheduleReconnect() {
        if (this.closed) {
            return;
        }
        if (this.retryCount >= this.maxRetries) {
            this._connectionState = "closed";
            this._safeEmitError(new Error(`OpenAIWebSocketManager: max reconnect retries (${this.maxRetries}) exceeded.`));
            return;
        }
        const delayMs = this.backoffDelaysMs[Math.min(this.retryCount, this.backoffDelaysMs.length - 1)] ?? 1000;
        this.retryCount++;
        this._connectionState = "reconnecting";
        this.retryTimer = setTimeout(() => {
            if (this.closed) {
                return;
            }
            // The onClose handler already calls _scheduleReconnect() for the next
            // attempt, so we intentionally swallow the rejection here to avoid
            // double-scheduling (which would double-increment retryCount per
            // failed reconnect and exhaust the retry budget prematurely).
            this._openConnection().catch(() => { });
        }, delayMs);
    }
    /** Emit an error only if there are listeners; prevents Node.js from crashing
     *  with "unhandled 'error' event" when no one is listening. */
    _safeEmitError(err) {
        if (this.listenerCount("error") > 0) {
            this.emit("error", err);
        }
    }
    _cancelRetryTimer() {
        if (this.retryTimer !== null) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }
    _handleMessage(data) {
        let text;
        if (typeof data === "string") {
            text = data;
        }
        else if (Buffer.isBuffer(data)) {
            text = data.toString("utf8");
        }
        else if (data instanceof ArrayBuffer) {
            text = Buffer.from(data).toString("utf8");
        }
        else {
            // Blob or other — coerce to string
            text = String(data);
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            this._safeEmitError(new Error(`OpenAIWebSocketManager: failed to parse message: ${text.slice(0, 200)}`));
            return;
        }
        if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
            this._safeEmitError(new Error(`OpenAIWebSocketManager: unexpected message shape (no "type" field): ${text.slice(0, 200)}`));
            return;
        }
        const event = parsed;
        // Track previous_response_id on completion
        if (event.type === "response.completed" && event.response?.id) {
            this._previousResponseId = event.response.id;
        }
        this.emit("message", event);
    }
    /**
     * Sends a warm-up event to pre-load the connection and model without generating output.
     * Pass tools/instructions to prime the connection for the upcoming session.
     */
    warmUp(params) {
        const event = buildOpenAIWebSocketWarmUpPayload(params);
        this.send(event);
    }
}
export function getOpenAIWebSocketErrorDetails(event) {
    return {
        status: typeof event.status === "number" ? event.status : undefined,
        type: event.error?.type,
        code: event.error?.code ?? event.code,
        message: event.error?.message ?? event.message,
        param: event.error?.param ?? event.param,
    };
}
function isRetryableWebSocketClose(code) {
    return (code === 1001 ||
        code === 1005 ||
        code === 1006 ||
        code === 1011 ||
        code === 1012 ||
        code === 1013);
}
