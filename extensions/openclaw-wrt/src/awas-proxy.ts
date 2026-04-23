/**
 * AWAS (OpenClaw WRT Auth Server) WebSocket proxy.
 *
 * For each connected router device, the bridge opens a dedicated
 * WebSocket connection to the AWAS auth server, enabling:
 *
 *   Router ──heartbeat──▶  Bridge ──forward──▶  AWAS
 *   Router ◀──command────  Bridge ◀──command──  AWAS
 *
 * Commands from AWAS (auth, kickoff, tmp_pass, etc.) are transparently
 * forwarded to the router through its existing bridge WebSocket.
 */

import { WebSocket } from "ws";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
};

type JsonRecord = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getMessageOp(message: JsonRecord): string | undefined {
  return asString(message.op) ?? asString(message.type);
}

function isResponseType(type: string): boolean {
  return type === "request_error" || type.endsWith("_response") || type.endsWith("_error");
}

function isEnvelopeResponse(message: JsonRecord): boolean {
  const response = message.response;
  return typeof response === "string" && /^\d+$/.test(response);
}

export type AwasConfig = {
  enabled: boolean;
  host: string;
  port: number;
  path: string;
  /** If true, use wss:// instead of ws:// */
  ssl: boolean;
};

/**
 * Callback invoked when AWAS sends a command that needs to be
 * forwarded to the router device.
 */
export type AwasCommandHandler = (deviceId: string, command: JsonRecord) => void;

const RECONNECT_BASE_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_QUEUED_AWAS_MESSAGES = 128;
const SENSITIVE_AWAS_PAYLOAD_KEYS = new Set([
  "key",
  "password",
  "passwd",
  "token",
  "client_token",
  "auth_token",
  "command",
]);

function redactPayloadForDebug(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactPayloadForDebug(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = SENSITIVE_AWAS_PAYLOAD_KEYS.has(key.toLowerCase())
      ? "[REDACTED]"
      : redactPayloadForDebug(entry);
  }
  return redacted;
}

/**
 * Manages one WebSocket connection to AWAS for a single router device.
 */
export class AwasDeviceProxy {
  private readonly deviceId: string;
  private readonly config: AwasConfig;
  private readonly logger: Logger;
  private readonly onCommand: AwasCommandHandler;

  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  // Queue messages that arrive before the AWAS connection is open
  private messageQueue: JsonRecord[] = [];
  private reconnectAttempts = 0;
  private stopped = false;

  constructor(params: {
    deviceId: string;
    config: AwasConfig;
    logger: Logger;
    onCommand: AwasCommandHandler;
  }) {
    this.deviceId = params.deviceId;
    this.config = params.config;
    this.logger = params.logger;
    this.onCommand = params.onCommand;
  }

  /** Open the WebSocket connection to AWAS. */
  connect(): void {
    if (this.stopped) {
      return;
    }
    this.cleanup();

    const protocol = this.config.ssl ? "wss" : "ws";
    const url = `${protocol}://${this.config.host}:${this.config.port}${this.config.path}`;

    this.logger.info(`awas-proxy: connecting to ${url} for device ${this.deviceId}`);

    try {
      this.ws = new WebSocket(url);
    } catch (error) {
      this.logger.error(
        `awas-proxy: failed to create WebSocket for device ${this.deviceId}: ${String(error)}`,
      );
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.logger.info(`awas-proxy: connected to AWAS for device ${this.deviceId}`);
      // Flush any queued messages that arrived before the AWAS connection
      if (this.messageQueue.length > 0) {
        this.logger.info(
          `awas-proxy: flushing ${this.messageQueue.length} queued messages to AWAS for device ${this.deviceId}`,
        );
        for (const queued of this.messageQueue.splice(0)) {
          this.sendToAwas(queued);
        }
      }
      this.startPing();
    });

    this.ws.on("message", (raw) => {
      this.handleAwasMessage(raw);
    });

    this.ws.on("close", (code, reason) => {
      this.logger.info(
        `awas-proxy: AWAS connection closed for device ${this.deviceId} code=${code} reason=${reason?.toString() ?? ""}`,
      );
      this.stopPing();
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", (error) => {
      this.logger.warn(
        `awas-proxy: AWAS connection error for device ${this.deviceId}: ${String(error)}`,
      );
    });
  }

  /** Close the connection and stop reconnection attempts. */
  disconnect(): void {
    this.stopped = true;
    this.cleanup();
    this.logger.info(`awas-proxy: disconnected from AWAS for device ${this.deviceId}`);
  }

  /**
   * Forward a message from the router to the AWAS server.
   * Typically used for heartbeats and connect messages.
   */
  forwardToAwas(message: JsonRecord): void {
    // Ensure device_id is always present
    const enriched: JsonRecord = { ...message, device_id: this.deviceId };
    // If AWAS is not connected, queue the message to be sent when connection is ready
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.debug?.(
        `awas-proxy: queuing message for device=${this.deviceId} op=${(enriched.op as string) ?? "unknown"} req_id=${(enriched.req_id as string) ?? "none"}`,
      );
      this.enqueueMessage(enriched);
      return;
    }
    this.sendToAwas(enriched);
  }

  /** Check if the AWAS connection is open. */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ─── Private helpers ───────────────────────────────────────

  private sendToAwas(payload: JsonRecord): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(
        `awas-proxy: cannot send to AWAS (not connected) for device ${this.deviceId}`,
      );
      // queue the payload so it will be sent once the connection opens
      this.enqueueMessage(payload);
      return;
    }
    const text = JSON.stringify(payload);
    this.logger.debug?.(
      `awas-proxy: sendToAwas full payload for device=${this.deviceId} payload=${JSON.stringify(redactPayloadForDebug(payload))}`,
    );
    try {
      this.ws.send(text, (err) => {
        if (err) {
          this.logger.warn(
            `awas-proxy: failed to send to AWAS for device ${this.deviceId}: ${String(err)}`,
          );
          this.enqueueMessage(payload);
        } else {
          this.logger.info?.(
            `awas-proxy: sent to AWAS device=${this.deviceId} op=${(payload.op as string) ?? (payload.type as string) ?? "unknown"} req_id=${(payload.req_id as string) ?? (payload.request_id as string) ?? (payload.reqId as string) ?? "none"}`,
          );
        }
      });
    } catch (error) {
      this.logger.warn(
        `awas-proxy: failed to send to AWAS for device ${this.deviceId}: ${String(error)}`,
      );
      this.enqueueMessage(payload);
    }
  }

  private handleAwasMessage(rawData: unknown): void {
    const rawText = typeof rawData === "string" ? rawData : String(rawData);
    let message: JsonRecord;
    try {
      const parsed = JSON.parse(rawText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("message must be a JSON object");
      }
      message = parsed as JsonRecord;
    } catch (error) {
      this.logger.warn(
        `awas-proxy: invalid JSON from AWAS for device ${this.deviceId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const op = getMessageOp(message);
    this.logger.debug?.(
      `awas-proxy: received from AWAS op=${op ?? "unknown"} for device ${this.deviceId}`,
    );

    // Ignore protocol-level acknowledgements and control frames.
    if (!op) {
      if (isEnvelopeResponse(message)) {
        this.logger.debug?.(
          `awas-proxy: ignored envelope response from AWAS for device ${this.deviceId}`,
        );
      } else {
        this.logger.warn(
          `awas-proxy: ignored AWAS message without op/type for device ${this.deviceId}`,
        );
      }
      return;
    }

    if (op === "connect" || op === "heartbeat") {
      this.logger.debug?.(
        `awas-proxy: ignored control op=${op} from AWAS for device ${this.deviceId}`,
      );
      return;
    }

    // Ignore legacy AWAS acknowledgement frames (*_response, *_error) that are not commands
    if (isResponseType(op)) {
      this.logger.debug?.(
        `awas-proxy: ignored response frame op=${op} from AWAS for device ${this.deviceId}`,
      );
      return;
    }

    // Forward the command to the router device through the bridge
    this.onCommand(this.deviceId, {
      ...message,
      op,
    });
  }

  private enqueueMessage(payload: JsonRecord): void {
    if (this.messageQueue.length >= MAX_QUEUED_AWAS_MESSAGES) {
      this.messageQueue.shift();
      this.logger.warn(
        `awas-proxy: dropping oldest queued message for device ${this.deviceId} because AWAS is disconnected and the queue reached ${MAX_QUEUED_AWAS_MESSAGES} messages`,
      );
    }
    this.messageQueue.push(payload);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;

    this.logger.info(
      `awas-proxy: reconnecting to AWAS for device ${this.deviceId} in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch {
          // ignore
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private cleanup(): void {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}

/**
 * Manages all per-device AWAS proxy connections.
 */
export class AwasProxyManager {
  private config: AwasConfig;
  private readonly logger: Logger;
  private readonly onCommand: AwasCommandHandler;
  private readonly proxies = new Map<string, AwasDeviceProxy>();

  constructor(params: { config: AwasConfig; logger: Logger; onCommand: AwasCommandHandler }) {
    this.config = params.config;
    this.logger = params.logger;
    this.onCommand = params.onCommand;
  }

  /**
   * Updates the manager's configuration.
   * If config changes, all existing device proxies are stopped to force
   * reconnection with the new settings.
   * @param config The new AWAS configuration.
   * @param currentDeviceIds Optional list of device IDs that should have an active proxy.
   *                           If provided, proxies will be ensured for these IDs after update.
   *                           If not provided, proxies will only be re-established for IDs that already had one.
   */
  updateConfig(config: AwasConfig, currentDeviceIds?: string[]): void {
    const oldConfig = this.config;
    const changed =
      oldConfig.enabled !== config.enabled ||
      oldConfig.host !== config.host ||
      oldConfig.port !== config.port ||
      oldConfig.path !== config.path ||
      oldConfig.ssl !== config.ssl;

    if (!changed) {
      return;
    }

    const deviceIdsToEnsure = currentDeviceIds ?? Array.from(this.proxies.keys());
    this.stopAll();
    this.config = config;

    if (this.config.enabled) {
      for (const deviceId of deviceIdsToEnsure) {
        this.ensureProxy(deviceId);
      }
    }
  }

  /** Whether the AWAS proxy feature is enabled. */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Called when a device connects or sends a heartbeat.
   * Creates a new proxy if one doesn't exist for this device.
   */
  ensureProxy(deviceId: string): void {
    if (!this.config.enabled) {
      return;
    }

    if (this.proxies.has(deviceId)) {
      return;
    }

    const proxy = new AwasDeviceProxy({
      deviceId,
      config: this.config,
      logger: this.logger,
      onCommand: this.onCommand,
    });
    this.proxies.set(deviceId, proxy);
    proxy.connect();
  }

  /**
   * Forward a message from a device to its AWAS proxy.
   */
  forwardToAwas(deviceId: string, message: JsonRecord): void {
    if (!this.config.enabled) {
      return;
    }
    const rid = message.req_id ?? message.request_id ?? message.reqId;
    const type = typeof message.type === "string" ? message.type : "unknown";
    this.logger.debug?.(
      `awas-proxy: forwardToAwas device=${deviceId} req_id=${(rid as string) ?? "none"} type=${type}`,
    );
    const proxy = this.proxies.get(deviceId);
    if (proxy) {
      proxy.forwardToAwas(message);
    }
  }

  /**
   * Called when a device disconnects. Tears down the AWAS proxy.
   */
  removeProxy(deviceId: string): void {
    const proxy = this.proxies.get(deviceId);
    if (proxy) {
      proxy.disconnect();
      this.proxies.delete(deviceId);
    }
  }

  /**
   * Stop all proxies (called during bridge shutdown).
   */
  stopAll(): void {
    for (const [deviceId, proxy] of this.proxies.entries()) {
      proxy.disconnect();
      this.proxies.delete(deviceId);
    }
  }
}
