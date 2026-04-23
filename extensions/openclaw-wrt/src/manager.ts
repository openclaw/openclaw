import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { AwasProxyManager } from "./awas-proxy.js";
import type { ResolvedClawWRTConfig } from "./config.js";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
};

type JsonRecord = Record<string, unknown>;

export type DeviceSnapshot = {
  deviceId: string;
  connectedAtMs: number;
  lastSeenAtMs: number;
  remoteAddress?: string;
  gateway?: unknown;
  deviceInfo?: unknown;
  authMode?: number;
  alias?: string;
};

type PendingRequest = {
  deviceId: string;
  socket: WebSocket;
  resolve: (value: JsonRecord) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  createdAtMs: number;
};

type DeviceSession = {
  socket: WebSocket;
  snapshot: DeviceSnapshot;
};

const AUTH_MODE_CLOUD = 0;
const AUTH_MODE_BYPASS = 1;
const AUTH_MODE_LOCAL = 2;

function asObject(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }
  return undefined;
}

function parseAuthModeValue(value: unknown): number | undefined {
  const numeric = asInteger(value);
  if (numeric === AUTH_MODE_CLOUD || numeric === AUTH_MODE_BYPASS || numeric === AUTH_MODE_LOCAL) {
    return numeric;
  }

  const normalized = asString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "cloud") {
    return AUTH_MODE_CLOUD;
  }
  if (normalized === "bypass") {
    return AUTH_MODE_BYPASS;
  }
  if (normalized === "local") {
    return AUTH_MODE_LOCAL;
  }
  return undefined;
}

function resolveDeviceAuthMode(message: JsonRecord): number | undefined {
  const topLevel = parseAuthModeValue(message.mode);
  if (topLevel !== undefined) {
    return topLevel;
  }

  const gateway = Array.isArray(message.gateway) ? message.gateway : [];
  for (const entry of gateway) {
    const mode = parseAuthModeValue(asObject(entry)?.auth_mode);
    if (mode !== undefined) {
      return mode;
    }
  }

  return undefined;
}

function shouldForwardConnectOrHeartbeatToAwas(
  message: JsonRecord,
  snapshot?: DeviceSnapshot,
): boolean {
  const mode = resolveDeviceAuthMode(message) ?? snapshot?.authMode;
  // Backward compatibility: legacy payloads without mode/auth_mode keep old behavior.
  return mode === undefined || mode === AUTH_MODE_CLOUD;
}

function getMessageData(message: JsonRecord): JsonRecord | null {
  return asObject(message.data);
}

function getMessageOp(message: JsonRecord): string | undefined {
  const data = getMessageData(message);
  return (
    asString(message.op) ?? asString(message.type) ?? asString(data?.op) ?? asString(data?.type)
  );
}

function getMessageReqId(message: JsonRecord): string | number | undefined {
  const data = getMessageData(message);
  const reqId =
    message.req_id ??
    message.request_id ??
    message.reqId ??
    data?.req_id ??
    data?.request_id ??
    data?.reqId;
  return typeof reqId === "string" || typeof reqId === "number" ? reqId : undefined;
}

function normalizeDeviceResponseForCaller(message: JsonRecord, op: string | undefined): JsonRecord {
  const data = getMessageData(message);
  if (!data) {
    return op ? { ...message, op } : message;
  }
  const nestedData = asObject(data.data);
  return {
    ...message,
    ...data,
    ...nestedData,
    op:
      op ??
      asString(data.op) ??
      asString(data.type) ??
      asString(message.op) ??
      asString(message.type),
  };
}

function isResponseType(type: string): boolean {
  return type === "request_error" || type.endsWith("_response") || type.endsWith("_error");
}

function isEnvelopeResponse(message: JsonRecord): boolean {
  // New response format: { response: "200", data: {...} } or { response: "400", msg: "error" }
  const response = message.response;
  return typeof response === "string" && /^\d+$/.test(response);
}

function isErrorResponse(message: JsonRecord): boolean {
  // New error format: { response: "4xx/5xx", msg: "error message" }
  const response = message.response;
  if (typeof response !== "string" || !/^\d+$/.test(response)) {
    return false;
  }
  // 2xx status codes are success, everything else is an error
  const code = parseInt(response, 10);
  return code < 200 || code >= 300;
}

function isOneWayOperation(type: string): boolean {
  return type === "auth" || type === "tmp_pass" || type === "reboot_device";
}

const SENSITIVE_PAYLOAD_KEYS = new Set([
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
    redacted[key] = SENSITIVE_PAYLOAD_KEYS.has(key.toLowerCase())
      ? "[REDACTED]"
      : redactPayloadForDebug(entry);
  }
  return redacted;
}

export class ClawWRTBridge {
  // Process-global singleton keyed by Symbol.for so the bridge instance survives
  // jiti module re-evaluation across separate plugin registry loads.
  private static readonly INSTANCE_KEY = Symbol.for("openclaw.openclaw-wrt.bridge");

  static getOrCreate(params: { config: ResolvedClawWRTConfig; logger: Logger }): ClawWRTBridge {
    const g = globalThis as Record<symbol, ClawWRTBridge | undefined>;
    const existing = g[ClawWRTBridge.INSTANCE_KEY];
    if (existing) {
      existing.updateConfig(params.config);
      return existing;
    }
    const instance = new ClawWRTBridge(params);
    g[ClawWRTBridge.INSTANCE_KEY] = instance;
    return instance;
  }

  private config: ResolvedClawWRTConfig;
  private readonly logger: Logger;
  private readonly server: http.Server;
  private wss: WebSocketServer | null;
  private readonly sessions = new Map<string, DeviceSession>();
  private readonly socketToDeviceId = new Map<WebSocket, string>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly deviceAliases = new Map<string, string>();
  private readonly awasProxy: AwasProxyManager;
  // Map of deviceId -> req_id -> timeout timer for AWAS-initiated requests.
  private readonly awasPending = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();
  // Per-device queue: each request waits for the previous request to complete.
  private readonly deviceSendQueue = new Map<string, Promise<void>>();
  private nextAliasId = 1;
  private started = false;

  constructor(params: { config: ResolvedClawWRTConfig; logger: Logger }) {
    this.config = params.config;
    this.logger = params.logger;

    // Initialize AWAS proxy manager
    this.awasProxy = new AwasProxyManager({
      config: this.config.awas,
      logger: this.logger,
      onCommand: (deviceId, command) => {
        this.handleAwasCommand(deviceId, command);
      },
    });

    this.loadAliases();

    this.server = http.createServer((req, res) => {
      // If AWAS HTTP proxying is enabled and the request targets the captive
      // portal path, forward the request to AWAS.
      // AWAS HTTP proxy removed: HTTP requests are served directly by AWAS.

      // Default response for non-proxied requests
      res.statusCode = 426;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("Upgrade Required");
    });
    this.wss = this.createWebSocketServer();

    this.server.on("upgrade", (req, socket, head) => {
      let requestPath = "/";
      try {
        requestPath = (req.url ? new URL(req.url, "http://localhost").pathname : "/") || "/";
      } catch (error) {
        this.logger.warn(
          `openclaw-wrt: rejected upgrade request with invalid url target=${req.url ?? ""} err=${String(error)}`,
        );
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      if (requestPath !== this.config.path) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const wss = this.wss;
      if (!wss) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    });
  }

  private createWebSocketServer(): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true, maxPayload: this.config.maxPayloadBytes });
    wss.on("connection", (socket, req) => {
      const remoteAddress = req.socket.remoteAddress;
      this.logger.info(
        `openclaw-wrt: websocket connected path=${this.config.path} remote=${remoteAddress ?? "unknown"}`,
      );

      socket.on("message", (data) => {
        void this.handleMessage(socket, data, remoteAddress);
      });

      socket.on("close", () => {
        this.handleClose(socket);
      });

      socket.on("error", (error) => {
        this.logger.warn(
          `openclaw-wrt: websocket error remote=${remoteAddress ?? "unknown"} err=${String(error)}`,
        );
      });
    });

    return wss;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (!this.config.enabled) {
      return;
    }
    if (!this.wss) {
      this.wss = this.createWebSocketServer();
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, this.config.bind, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.started = true;
    this.logger.info(
      `openclaw-wrt: listening on ws://${this.config.bind}:${this.config.port}${this.config.path}`,
    );
  }

  async stop(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("openclaw-wrt bridge stopped"));
    }
    this.pending.clear();
    for (const timersByReqId of this.awasPending.values()) {
      for (const timer of timersByReqId.values()) {
        clearTimeout(timer);
      }
    }
    this.awasPending.clear();
    this.deviceSendQueue.clear();

    if (!this.started) {
      return;
    }

    for (const session of this.sessions.values()) {
      try {
        session.socket.close();
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
    this.socketToDeviceId.clear();

    // Stop all AWAS proxy connections
    this.awasProxy.stopAll();

    const wss = this.wss;
    this.wss = null;
    if (wss) {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    this.started = false;
  }

  updateConfig(config: ResolvedClawWRTConfig): void {
    const oldConfig = this.config;
    this.config = config;

    const idsToProxy: string[] = [];
    for (const [deviceId, session] of this.sessions.entries()) {
      if (shouldForwardConnectOrHeartbeatToAwas({}, session.snapshot)) {
        idsToProxy.push(deviceId);
      }
    }
    this.awasProxy.updateConfig(config.awas, idsToProxy);

    if (oldConfig.enabled && !config.enabled && this.started) {
      void this.stop().catch((error) => {
        this.logger.error(
          `openclaw-wrt: failed to stop bridge during reconfiguration: ${String(error)}`,
        );
      });
    } else if (!oldConfig.enabled && config.enabled && !this.started) {
      void this.start().catch((error) => {
        this.logger.error(
          `openclaw-wrt: failed to start bridge during reconfiguration: ${String(error)}`,
        );
      });
    } else if (this.started) {
      if (oldConfig.maxPayloadBytes !== config.maxPayloadBytes) {
        this.logger.info(
          `openclaw-wrt: maxPayloadBytes changed from ${oldConfig.maxPayloadBytes} to ${config.maxPayloadBytes}. Rebuilding WebSocket server to apply new limits.`,
        );
        const oldWss = this.wss;
        this.wss = this.createWebSocketServer();
        if (oldWss) {
          oldWss.close(); // Close existing connections to enforce new limits.
        }
      }

      // If port/bind/path changed while started, log a warning as those require a restart (stop/start cycle)
      if (
        oldConfig.port !== config.port ||
        oldConfig.bind !== config.bind ||
        oldConfig.path !== config.path
      ) {
        this.logger.warn(
          "openclaw-wrt: config changed (port/bind/path) while bridge was already running. These changes will take effect after the next restart (stop then start cycle).",
        );
      }
    }
  }

  listDevices(): DeviceSnapshot[] {
    return [...this.sessions.values()]
      .map((entry) => Object.assign({}, entry.snapshot))
      .toSorted((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  private findDeviceIdByAlias(
    aliasCandidate: string,
    excludingDeviceId?: string,
  ): string | undefined {
    const candidate = aliasCandidate.trim().toLowerCase();
    for (const [deviceId, alias] of this.deviceAliases.entries()) {
      if (deviceId === excludingDeviceId) {
        continue;
      }
      if (alias.toLowerCase() === candidate) {
        return deviceId;
      }
    }
    return undefined;
  }

  private isAliasAvailable(
    aliasCandidate: string,
    excludingDeviceId?: string,
    reservedDeviceId?: string,
  ): boolean {
    const candidate = aliasCandidate.trim().toLowerCase();
    if (reservedDeviceId && reservedDeviceId.toLowerCase() === candidate) {
      return false;
    }
    for (const deviceId of this.sessions.keys()) {
      if (deviceId === excludingDeviceId) {
        continue;
      }
      if (deviceId.toLowerCase() === candidate) {
        return false;
      }
    }
    return !this.findDeviceIdByAlias(aliasCandidate, excludingDeviceId);
  }

  private allocateAlias(excludingDeviceId?: string, reservedDeviceId?: string): string {
    while (true) {
      const alias = `Router-${this.nextAliasId++}`;
      if (this.isAliasAvailable(alias, excludingDeviceId, reservedDeviceId)) {
        return alias;
      }
    }
  }

  private assignAlias(deviceId: string): string {
    let alias = this.deviceAliases.get(deviceId);
    if (!alias || !this.isAliasAvailable(alias, deviceId)) {
      alias = this.allocateAlias(deviceId);
      this.deviceAliases.set(deviceId, alias);
      this.saveAliases();
    }

    const session = this.sessions.get(deviceId);
    if (session) {
      session.snapshot.alias = alias;
    }
    return alias;
  }

  private reassignAliasConflictingWithDeviceId(deviceId: string): void {
    const conflictingDeviceId = this.findDeviceIdByAlias(deviceId, deviceId);
    if (!conflictingDeviceId) {
      return;
    }
    const alias = this.allocateAlias(conflictingDeviceId, deviceId);
    this.deviceAliases.set(conflictingDeviceId, alias);
    this.saveAliases();
    const session = this.sessions.get(conflictingDeviceId);
    if (session) {
      session.snapshot.alias = alias;
    }
  }

  private resolveConnectedDeviceId(deviceIdOrAlias: string): string {
    const candidate = deviceIdOrAlias.trim();
    if (this.sessions.has(candidate)) {
      return candidate;
    }
    const aliasDeviceId = this.findDeviceIdByAlias(candidate);
    if (aliasDeviceId) {
      return aliasDeviceId;
    }
    return candidate;
  }

  getDevice(deviceId: string): DeviceSnapshot | null {
    const resolvedDeviceId = this.resolveConnectedDeviceId(deviceId);
    const session = this.sessions.get(resolvedDeviceId);
    return session ? { ...session.snapshot } : null;
  }

  async callDevice(params: {
    deviceId: string;
    op: string;
    payload?: JsonRecord;
    timeoutMs?: number;
    expectResponse?: boolean;
  }): Promise<JsonRecord> {
    const queueDeviceId = this.resolveConnectedDeviceId(params.deviceId);
    return await this.enqueueDeviceCall(queueDeviceId, async () => {
      const deviceId = this.resolveConnectedDeviceId(params.deviceId);

      const op = params.op.trim();
      const session = this.sessions.get(deviceId);
      if (!session) {
        throw new Error(`device offline or not found: ${params.deviceId}`);
      }
      if (session.socket.readyState !== WebSocket.OPEN) {
        throw new Error(`device socket not open: ${deviceId}`);
      }

      const reqId = this.generateReqIdForDevice(deviceId);
      const reqKey = reqId;
      const payload: JsonRecord = {
        ...params.payload,
        req_id: reqId,
        op: op,
      };
      if (!("device_id" in payload) && op !== "connect" && op !== "heartbeat") {
        payload.device_id = deviceId;
      }

      const expectResponse = params.expectResponse ?? !isOneWayOperation(op);
      const timeoutMs = Math.max(1000, params.timeoutMs ?? this.config.requestTimeoutMs);

      this.logger.info?.(
        `openclaw-wrt: sending request device=${deviceId} op=${op} req_id=${reqKey} expect_response=${expectResponse} timeout_ms=${timeoutMs}`,
      );
      this.logger.debug?.(
        `openclaw-wrt: outbound payload device=${deviceId} req_id=${reqKey} payload=${JSON.stringify(redactPayloadForDebug(payload))}`,
      );

      return await new Promise<JsonRecord>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          fn();
        };

        if (expectResponse) {
          const createdAtMs = Date.now();
          const timer = setTimeout(() => {
            this.pending.delete(reqKey);
            const pendingForDevice = this.collectPendingReqIdsForDevice(deviceId);
            const pendingPreview =
              pendingForDevice.length > 0 ? pendingForDevice.slice(0, 5).join(",") : "none";
            const elapsedMs = Date.now() - createdAtMs;
            this.logger.warn(
              `openclaw-wrt: request timeout device=${deviceId} op=${op} req_id=${reqKey} socket_state=${session.socket.readyState} pending_device_count=${pendingForDevice.length} pending_preview=${pendingPreview} age_ms=${elapsedMs}`,
            );
            finish(() => reject(new Error(`request timeout: ${op}`)));
          }, timeoutMs);
          this.pending.set(reqKey, {
            deviceId,
            socket: session.socket,
            timer,
            createdAtMs,
            resolve: (value) => finish(() => resolve(value)),
            reject: (error) => finish(() => reject(error)),
          });
        }

        try {
          session.socket.send(JSON.stringify(payload), (error) => {
            if (error) {
              if (expectResponse) {
                const pending = this.pending.get(reqKey);
                if (pending) {
                  clearTimeout(pending.timer);
                  this.pending.delete(reqKey);
                }
              }
              finish(() => reject(error));
              return;
            }
            this.logger.info?.(
              `openclaw-wrt: request sent device=${deviceId} op=${op} req_id=${reqKey}`,
            );
            if (!expectResponse) {
              finish(() => resolve({ status: "sent", req_id: reqId, type: op }));
            }
          });
        } catch (error) {
          if (expectResponse) {
            const pending = this.pending.get(reqKey);
            if (pending) {
              clearTimeout(pending.timer);
              this.pending.delete(reqKey);
            }
          }
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
      });
    });
  }

  private generateReqId(): string {
    return randomBytes(8).toString("hex");
  }

  private async enqueueDeviceCall<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.deviceSendQueue.get(deviceId) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(async () => {
        return await fn();
      });
    const chainedPromise = queued.then(
      () => undefined,
      () => undefined,
    );
    this.deviceSendQueue.set(deviceId, chainedPromise);
    // Clean up the queue entry after completion (if it's still the one we set).
    // This prevents unbounded growth in long-lived processes with many device IDs.
    void chainedPromise.finally(() => {
      if (this.deviceSendQueue.get(deviceId) === chainedPromise) {
        this.deviceSendQueue.delete(deviceId);
      }
    });
    return await queued;
  }

  private collectPendingReqIdsForDevice(deviceId: string): string[] {
    const reqIds: string[] = [];
    for (const [reqId, pending] of this.pending.entries()) {
      if (pending.deviceId === deviceId) {
        reqIds.push(reqId);
      }
    }
    return reqIds;
  }

  private rejectPendingRequestsForSocket(
    socket: WebSocket,
    reason: (deviceId: string) => string,
  ): void {
    for (const [reqId, pending] of this.pending.entries()) {
      if (pending.socket !== socket) {
        continue;
      }
      clearTimeout(pending.timer);
      this.pending.delete(reqId);
      pending.reject(new Error(reason(pending.deviceId)));
    }
  }

  private hasLocalPendingForDevice(deviceId: string, reqId: string | number): boolean {
    const pending = this.pending.get(String(reqId));
    return pending?.deviceId === deviceId;
  }

  private hasAnyLocalPending(reqId: string | number): boolean {
    return this.pending.has(String(reqId));
  }

  private generateReqIdForDevice(deviceId: string): string {
    while (true) {
      const reqId = this.generateReqId();
      if (this.hasAnyLocalPending(reqId)) {
        continue;
      }
      if (this.getAwasPendingTimer(deviceId, reqId)) {
        continue;
      }
      return reqId;
    }
  }

  private getAwasPendingTimer(
    deviceId: string,
    reqId: string | number,
  ): ReturnType<typeof setTimeout> | undefined {
    return this.awasPending.get(deviceId)?.get(String(reqId));
  }

  private setAwasPendingTimer(
    deviceId: string,
    reqId: string | number,
    timer: ReturnType<typeof setTimeout>,
  ): void {
    const reqIdKey = String(reqId);
    let timersByReqId = this.awasPending.get(deviceId);
    if (!timersByReqId) {
      timersByReqId = new Map<string, ReturnType<typeof setTimeout>>();
      this.awasPending.set(deviceId, timersByReqId);
    }
    timersByReqId.set(reqIdKey, timer);
  }

  private deleteAwasPendingTimer(deviceId: string, reqId: string | number): void {
    const timersByReqId = this.awasPending.get(deviceId);
    if (!timersByReqId) {
      return;
    }
    timersByReqId.delete(String(reqId));
    if (timersByReqId.size === 0) {
      this.awasPending.delete(deviceId);
    }
  }

  private clearAwasStateForDevice(deviceId: string): void {
    const timersByReqId = this.awasPending.get(deviceId);
    if (timersByReqId) {
      for (const timer of timersByReqId.values()) {
        clearTimeout(timer);
      }
      this.awasPending.delete(deviceId);
    }
    this.awasProxy.removeProxy(deviceId);
  }

  private clearDeviceState(deviceId: string): void {
    this.clearAwasStateForDevice(deviceId);
  }

  private loadAliases(): void {
    try {
      const file = this.config.aliasFile;
      if (fs.existsSync(file)) {
        const data = fs.readFileSync(file, "utf8");
        const json = JSON.parse(data) as Record<string, string>;
        for (const [deviceId, alias] of Object.entries(json)) {
          this.deviceAliases.set(deviceId, alias);
          const match = /^Router-(\d+)$/.exec(alias);
          if (match) {
            const id = parseInt(match[1], 10);
            if (id >= this.nextAliasId) {
              this.nextAliasId = id + 1;
            }
          }
        }
        this.logger.info(
          `openclaw-wrt: loaded ${this.deviceAliases.size} device aliases from ${file}`,
        );
      }
    } catch (error) {
      this.logger.warn(`openclaw-wrt: failed to load device aliases: ${String(error)}`);
    }
  }

  private saveAliases(): void {
    try {
      const file = this.config.aliasFile;
      const json: Record<string, string> = {};
      for (const [deviceId, alias] of this.deviceAliases.entries()) {
        json[deviceId] = alias;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(json, null, 2), "utf8");
    } catch (error) {
      this.logger.warn(`openclaw-wrt: failed to save device aliases: ${String(error)}`);
    }
  }

  private async handleMessage(
    socket: WebSocket,
    rawData: RawData,
    remoteAddress: string | undefined,
  ): Promise<void> {
    const rawText = typeof rawData === "string" ? rawData : (rawData as Buffer).toString("utf8");
    let message: JsonRecord;
    try {
      const parsed = JSON.parse(rawText) as unknown;
      const obj = asObject(parsed);
      if (!obj) {
        throw new Error("message must be a JSON object");
      }
      message = obj;
      this.logger.debug?.(
        `openclaw-wrt: incoming payload from ${remoteAddress ?? "unknown"}: ${JSON.stringify(redactPayloadForDebug(obj))}`,
      );
    } catch (error) {
      this.logger.debug?.(
        `openclaw-wrt: failed to parse incoming payload from ${remoteAddress ?? "unknown"} bytes=${rawText.length}`,
      );
      this.logger.warn(
        `openclaw-wrt: invalid JSON from remote=${remoteAddress ?? "unknown"} err=${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    // Accept op/type at top-level and in envelope data.type.
    const op = getMessageOp(message);
    const deviceId = asString(message.device_id);

    // Log incoming device message for diagnostics (op and req_id)
    const incomingReqId = message.req_id ?? message.request_id ?? message.reqId;
    this.logger.info?.(
      `openclaw-wrt: received from device remote=${remoteAddress ?? "unknown"} device=${deviceId ?? this.socketToDeviceId.get(socket) ?? "unknown"} op=${op ?? "unknown"} req_id=${String((incomingReqId as string | number) ?? "none")}`,
    );

    if (op === "connect" || op === "heartbeat") {
      if (!deviceId) {
        this.logger.warn("openclaw-wrt: missing device_id on connect/heartbeat");
        return;
      }

      // 1. Authenticate the connect/heartbeat attempt if a token is configured.
      const providedToken = asString(message.token) ?? asString(message.key);
      if (this.config.token && providedToken !== this.config.token) {
        // Allow tokenless heartbeats if the socket is already authenticated for this device.
        const isAlreadyAuthenticated = this.socketToDeviceId.get(socket) === deviceId;
        if (op === "heartbeat" && isAlreadyAuthenticated && providedToken === undefined) {
          this.logger.debug?.(
            `openclaw-wrt: allowed tokenless heartbeat for authenticated device ${deviceId}`,
          );
        } else {
          this.logger.warn(
            `openclaw-wrt: rejected auth for device ${deviceId} remote=${remoteAddress ?? "unknown"} due to invalid/missing token`,
          );
          socket.close(1008, "authentication failed");
          return;
        }
      }

      // 2. Validate allowlist.
      if (this.config.allowDeviceIds.length > 0 && !this.config.allowDeviceIds.includes(deviceId)) {
        this.logger.warn(`openclaw-wrt: rejected unlisted device ${deviceId}`);
        socket.close(1008, "device not allowed");
        return;
      }
      const now = Date.now();
      const previous = this.sessions.get(deviceId);
      const priorDeviceId = this.socketToDeviceId.get(socket);
      const priorSession = priorDeviceId ? this.sessions.get(priorDeviceId) : undefined;
      const supersededPriorSession = priorDeviceId ? priorSession?.socket !== socket : false;
      if (supersededPriorSession) {
        this.logger.warn(
          `openclaw-wrt: ignored stale ${op} from superseded socket prior_device=${priorDeviceId} requested_device=${deviceId} remote=${remoteAddress ?? "unknown"}`,
        );
        try {
          socket.close(1000, "superseded");
        } catch {
          // ignore
        }
        return;
      }
      if (priorDeviceId && priorDeviceId !== deviceId) {
        const remappingActivePriorSession = priorSession?.socket === socket;
        if (remappingActivePriorSession) {
          this.sessions.delete(priorDeviceId);
        }
        for (const [reqId, pending] of this.pending.entries()) {
          if (pending.deviceId !== priorDeviceId || pending.socket !== socket) {
            continue;
          }
          clearTimeout(pending.timer);
          this.pending.delete(reqId);
          pending.reject(new Error(`device disconnected: ${priorDeviceId}`));
        }
        if (remappingActivePriorSession) {
          this.clearDeviceState(priorDeviceId);
        }
      }

      this.reassignAliasConflictingWithDeviceId(deviceId);

      const authMode = resolveDeviceAuthMode(message) ?? previous?.snapshot.authMode;
      // 3. Update session immediately to avoid race conditions with the request queue.
      this.sessions.set(deviceId, {
        socket,
        snapshot: {
          deviceId,
          alias: previous?.snapshot.alias, // placeholder, updated by assignAlias below
          connectedAtMs: previous?.snapshot.connectedAtMs ?? now,
          lastSeenAtMs: now,
          remoteAddress,
          gateway: message.gateway ?? previous?.snapshot.gateway,
          deviceInfo: message.device_info ?? previous?.snapshot.deviceInfo,
          authMode,
        },
      });
      this.assignAlias(deviceId);
      const snapshot = this.sessions.get(deviceId)!.snapshot;
      this.socketToDeviceId.set(socket, deviceId);

      if (previous && previous.socket !== socket) {
        this.rejectPendingRequestsForSocket(previous.socket, (pendingDeviceId) => {
          return `device session superseded: ${pendingDeviceId}`;
        });
        this.logger.info(
          `openclaw-wrt: superseding existing session for ${deviceId} remote=${remoteAddress ?? "unknown"}`,
        );
        try {
          previous.socket.close(1000, "superseded");
        } catch {
          // ignore
        }
      }

      // Only cloud mode should connect/forward to AWAS.
      if (shouldForwardConnectOrHeartbeatToAwas(message, snapshot)) {
        this.awasProxy.ensureProxy(deviceId);
        this.logger.debug?.(
          `openclaw-wrt: forwarding message to AWAS for device=${deviceId} payload=${JSON.stringify(
            redactPayloadForDebug(message),
          )}`,
        );
        this.awasProxy.forwardToAwas(deviceId, message);
      } else {
        this.logger.debug?.(
          `openclaw-wrt: skipping AWAS forward for device=${deviceId} op=${op} due to non-cloud mode=${String(resolveDeviceAuthMode(message))}`,
        );
        this.clearAwasStateForDevice(deviceId);
      }
      return;
    }

    const reqId = getMessageReqId(message);
    // Check for response types: old format (type field) or new envelope format (response field)
    const isResponse = (op && isResponseType(op)) || isEnvelopeResponse(message);
    if (isResponse && (typeof reqId === "string" || typeof reqId === "number")) {
      const resolvedDeviceId = deviceId ?? this.socketToDeviceId.get(socket);
      // If this req_id matches an AWAS-initiated request, forward the
      // device response back to AWAS so AWAS can resolve its sendCommand().
      const awasTimer =
        resolvedDeviceId !== undefined
          ? this.getAwasPendingTimer(resolvedDeviceId, reqId)
          : undefined;
      if (awasTimer) {
        if (!resolvedDeviceId) {
          this.logger.warn(
            `openclaw-wrt: cannot determine deviceId to forward response req_id=${String(reqId)}; dropping`,
          );
          return;
        }
        const activeSession = this.sessions.get(resolvedDeviceId);
        if (activeSession?.socket !== socket) {
          this.logger.warn(
            `openclaw-wrt: dropped mismatched AWAS response req_id=${String(reqId)} device=${resolvedDeviceId}`,
          );
          return;
        }
        clearTimeout(awasTimer);
        this.deleteAwasPendingTimer(resolvedDeviceId, reqId);
        try {
          this.awasProxy.forwardToAwas(resolvedDeviceId, message);
          this.logger.info?.(
            `openclaw-wrt: forwarded device response back to AWAS device=${resolvedDeviceId} req_id=${String(reqId)} op=${String(message.op)}`,
          );
        } catch (e) {
          this.logger.warn(
            `openclaw-wrt: failed to forward device response ${String(reqId)} back to AWAS: ${String(e)}`,
          );
        }
        return;
      }

      const key = String(reqId);
      const pending = this.pending.get(key);
      if (!pending) {
        this.logger.debug?.(`openclaw-wrt: dropped unmatched response req_id=${key} op=${op}`);
        return;
      }
      if (pending.socket !== socket || pending.deviceId !== resolvedDeviceId) {
        this.logger.warn(
          `openclaw-wrt: dropped mismatched response req_id=${key} expected_device=${pending.deviceId} actual_device=${resolvedDeviceId ?? "unknown"}`,
        );
        return;
      }
      this.pending.delete(key);
      clearTimeout(pending.timer);

      const normalized = normalizeDeviceResponseForCaller(message, op);
      // Check for error responses: old format (type ends with _error) or new format (response field)
      if ((op && (op === "request_error" || op.endsWith("_error"))) || isErrorResponse(message)) {
        const data = getMessageData(message);
        // New error format: { response: "400", msg: "error message" }
        // Old error format: { type: "xxx_error", error: "error message" }
        const errorText =
          asString(message.msg) ??
          asString(data?.msg) ??
          asString(message.error) ??
          asString(data?.error) ??
          asString(message.message) ??
          asString(data?.message) ??
          `device request failed: ${op ?? "unknown error"}`;
        pending.reject(new Error(errorText));
        return;
      }
      pending.resolve(normalized);
      return;
    }

    this.logger.debug?.(
      `openclaw-wrt: unsolicited message op=${op ?? "unknown"} device=${deviceId ?? this.socketToDeviceId.get(socket) ?? "unknown"}`,
    );
  }

  private handleClose(socket: WebSocket): void {
    const deviceId = this.socketToDeviceId.get(socket);
    if (!deviceId) {
      return;
    }
    this.socketToDeviceId.delete(socket);
    const session = this.sessions.get(deviceId);
    const closedActiveSession = session?.socket === socket;
    if (closedActiveSession) {
      this.sessions.delete(deviceId);
    }

    for (const [reqId, pending] of this.pending.entries()) {
      if (pending.deviceId !== deviceId || pending.socket !== socket) {
        continue;
      }
      clearTimeout(pending.timer);
      this.pending.delete(reqId);
      pending.reject(new Error(`device disconnected: ${deviceId}`));
    }

    if (closedActiveSession) {
      this.clearDeviceState(deviceId);
      // Clean up any pending queue entry for this device
      this.deviceSendQueue.delete(deviceId);
    }
  }

  /**
   * Handle a command received from AWAS that should be forwarded to the router.
   * AWAS sends commands like: { type: "auth", client_mac: "...", ... }
   * or { type: "kickoff", client_ip: "...", client_mac: "...", gw_id: "..." }
   * or { type: "tmp_pass", client_mac: "...", timeout: 300 }
   */
  private handleAwasCommand(deviceId: string, command: JsonRecord): void {
    const session = this.sessions.get(deviceId);
    if (!session) {
      this.logger.warn(`awas-proxy: received command for offline device ${deviceId}, dropping`);
      return;
    }
    if (session.socket.readyState !== WebSocket.OPEN) {
      this.logger.warn(`awas-proxy: device ${deviceId} socket not open, dropping AWAS command`);
      return;
    }

    // Accept both op/type from AWAS and normalize to op for device-side protocol.
    const op = asString(command.op) ?? asString(command.type) ?? "unknown";
    this.logger.info(`awas-proxy: forwarding AWAS command op=${op} to device ${deviceId}`);

    const normalizedCommand: JsonRecord = {
      ...command,
      op,
    };

    try {
      // If AWAS included a req_id, we must wait for the device's response and
      // forward it back to AWAS so AWAS's sendCommand() can resolve.
      const reqIdCandidate =
        normalizedCommand.req_id ?? normalizedCommand.request_id ?? normalizedCommand.reqId;
      this.logger.debug?.(
        `awas-proxy: handleAwasCommand device=${deviceId} op=${op} req_id=${String((reqIdCandidate as string | number) ?? "none")}`,
      );
      if (typeof reqIdCandidate === "string" || typeof reqIdCandidate === "number") {
        const reqId = String(reqIdCandidate);
        if (this.hasLocalPendingForDevice(deviceId, reqIdCandidate)) {
          this.logger.warn(
            `awas-proxy: rejected AWAS command with colliding local req_id=${reqId} for device ${deviceId}`,
          );
          this.awasProxy.forwardToAwas(deviceId, {
            op: "request_error",
            req_id: reqId,
            error: "request id collision with local pending request",
          });
          return;
        }
        // Clear any existing pending for this id (shouldn't normally happen)
        const prev = this.getAwasPendingTimer(deviceId, reqIdCandidate);
        if (prev) {
          clearTimeout(prev);
          this.deleteAwasPendingTimer(deviceId, reqIdCandidate);
        }

        const timer = setTimeout(() => {
          // Timed out waiting for device response — inform AWAS with a request_error
          this.deleteAwasPendingTimer(deviceId, reqIdCandidate);
          this.logger.warn(`openclaw-wrt: AWAS request ${reqId} to ${deviceId} timed out`);
          try {
            this.awasProxy.forwardToAwas(deviceId, {
              op: "request_error",
              req_id: reqId,
              error: "request timeout",
            });
            this.logger.info?.(
              `awas-proxy: sent request_error back to AWAS device=${deviceId} req_id=${reqId}`,
            );
          } catch {
            this.logger.warn(`openclaw-wrt: failed to send timeout error to AWAS for ${reqId}`);
          }
        }, this.config.requestTimeoutMs);

        this.setAwasPendingTimer(deviceId, reqIdCandidate, timer);
        this.logger.info?.(
          `awas-proxy: registered awasPending device=${deviceId} req_id=${reqId} timeout=${this.config.requestTimeoutMs}ms`,
        );
      }

      session.socket.send(JSON.stringify(normalizedCommand), (error) => {
        const rid =
          typeof reqIdCandidate === "string" || typeof reqIdCandidate === "number"
            ? String(reqIdCandidate)
            : "none";
        if (error) {
          this.logger.warn(
            `awas-proxy: failed to forward command to device ${deviceId}: ${String(error)}`,
          );
          // If there was an AWAS pending, reply with an error immediately
          if (typeof reqIdCandidate === "string" || typeof reqIdCandidate === "number") {
            const reqId = String(reqIdCandidate);
            const pendingTimer = this.getAwasPendingTimer(deviceId, reqIdCandidate);
            if (pendingTimer) {
              clearTimeout(pendingTimer);
              this.deleteAwasPendingTimer(deviceId, reqIdCandidate);
            }
            this.awasProxy.forwardToAwas(deviceId, {
              op: "request_error",
              req_id: reqId,
              error: `forward error: ${String(error)}`,
            });
            this.logger.info?.(
              `awas-proxy: sent forward error back to AWAS device=${deviceId} req_id=${reqId}`,
            );
          }
          return;
        }
        this.logger.debug?.(
          `awas-proxy: forwarded command to device ${deviceId} req_id=${rid} op=${op}`,
        );
      });
    } catch (error) {
      this.logger.warn(
        `awas-proxy: error forwarding command to device ${deviceId}: ${String(error)}`,
      );
      const reqId =
        normalizedCommand.req_id ?? normalizedCommand.request_id ?? normalizedCommand.reqId;
      if (typeof reqId === "string" || typeof reqId === "number") {
        const reqIdText = String(reqId);
        const pendingTimer = this.getAwasPendingTimer(deviceId, reqId);
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          this.deleteAwasPendingTimer(deviceId, reqId);
        }
        try {
          this.awasProxy.forwardToAwas(deviceId, {
            op: "request_error",
            req_id: reqIdText,
            error: `forward exception: ${String(error)}`,
          });
        } catch {
          // swallow
        }
      }
    }
  }
}
