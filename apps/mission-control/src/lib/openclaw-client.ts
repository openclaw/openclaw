import WebSocket from "ws";
import { randomUUID, createHash, generateKeyPairSync, sign, KeyObject } from "crypto";

// --- Types ---

export interface OpenClawAgent {
  id: string;
  name?: string;
  model?: string;
  status?: string;
  sessionKey?: string;
}

export interface OpenClawSession {
  key: string;
  label?: string;
  displayName?: string;
  agentId?: string;
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  lastActivity?: string;
}

export interface OpenClawCronJob {
  id: string;
  agentId?: string;
  schedule: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  prompt?: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
}

export interface ChatSearchResultRow {
  id: string;
  entryId: string;
  sessionKey: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt: number;
  model?: string | null;
  provider?: string | null;
  channel?: string | null;
  accountId?: string | null;
  agentId?: string | null;
  parentId?: string | null;
  sessionTitle?: string | null;
}

export interface ChatSearchResult {
  results: ChatSearchResultRow[];
  nextOffset?: number;
}

export interface SessionsSearchResult {
  results: Array<{
    sessionKey: string;
    sessionId: string;
    title?: string | null;
    updatedAt?: number | null;
    channel?: string | null;
    accountId?: string | null;
    agentId?: string | null;
    matches: number;
    lastMessageAt?: number | null;
  }>;
  nextOffset?: number;
}

export interface ChatAnalyticsResult {
  messagesPerDay: Array<{ day: string; count: number }>;
  messagesByChannel: Array<{ channel: string | null; count: number }>;
  tokensByModel: Array<{ model: string | null; input: number; output: number; total: number }>;
}

type EventCallback = (data: unknown) => void;

// L1: Connection health metrics
export interface ConnectionMetrics {
  /** Whether the client is currently authenticated and connected */
  connected: boolean;
  /** ISO timestamp of when the client first connected (null if never connected) */
  firstConnectedAt: string | null;
  /** ISO timestamp of the most recent successful connection */
  lastConnectedAt: string | null;
  /** Current connection uptime in milliseconds (0 if disconnected) */
  uptimeMs: number;
  /** Total number of reconnect attempts since client creation */
  totalReconnects: number;
  /** Total number of successful connections */
  totalConnections: number;
  /** Average connection duration in milliseconds */
  avgConnectionDurationMs: number;
  /** Total events received */
  eventsReceived: number;
  /** Events received per second (rolling 60s window) */
  eventsPerSecond: number;
  /** Total sequence gaps detected (H2) */
  sequenceGapsDetected: number;
  /** Total tick stalls detected (H1) */
  tickStallsDetected: number;
  /** Number of circuit breaker trips (H3) */
  circuitBreakerTrips: number;
  /** Number of pending RPC requests right now */
  pendingRequests: number;
}

// --- Structured connection logging ---
function gwLog(level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), src: "OpenClawClient", msg, ...meta };
  if (level === "error") {console.error(`[OpenClawClient] ${msg}`, entry);}
  else if (level === "warn") {console.warn(`[OpenClawClient] ${msg}`, entry);}
  else {console.log(`[OpenClawClient] ${msg}`, entry);}
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  method?: string; // Track which RPC method this request is for
}

// Gateway protocol frame types
interface EventFrame {
  type: "event";
  event: string;
  seq?: number;
  payload?: unknown;
}

interface ResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message?: string; code?: number };
}

interface RequestFrame {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
}

// --- Device Identity (Ed25519 keypair, persisted per process) ---

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

interface DeviceIdentity {
  deviceId: string;       // hex SHA-256 of raw public key bytes
  publicKey: string;      // base64url of raw 32-byte Ed25519 public key
  privateKeyObj: KeyObject; // Node crypto KeyObject for signing
}

function generateDeviceIdentity(): DeviceIdentity {
  const kp = generateKeyPairSync("ed25519");
  // SPKI DER is 44 bytes: 12 byte header + 32 byte raw Ed25519 public key
  const spki = kp.publicKey.export({ type: "spki", format: "der" });
  const pubRaw = Buffer.from(spki).subarray(-32); // raw 32 bytes
  const deviceId = createHash("sha256").update(pubRaw).digest("hex");
  const publicKey = toBase64Url(pubRaw);
  return { deviceId, publicKey, privateKeyObj: kp.privateKey };
}

function signDeviceMessage(identity: DeviceIdentity, message: string): string {
  const sig = sign(null, Buffer.from(message, "utf-8"), identity.privateKeyObj);
  return toBase64Url(sig);
}

/** Build the signing message for device auth (matches gateway protocol). */
function buildSigningMessage(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string;
  nonce?: string;
}): string {
  const version = params.nonce ? "v2" : "v1";
  const parts = [
    version,
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token,
  ];
  if (version === "v2" && params.nonce) {
    parts.push(params.nonce);
  }
  return parts.join("|");
}

// Singleton device identity for the server process
const _deviceIdentity =
  (globalThis as Record<string, unknown>).__openclawDeviceIdentity as
  | DeviceIdentity
  | undefined;
const deviceIdentity: DeviceIdentity = _deviceIdentity ?? generateDeviceIdentity();
(globalThis as Record<string, unknown>).__openclawDeviceIdentity = deviceIdentity;

// --- Client ---

export class OpenClawClient {
  private ws: WebSocket | null = null;
  private url: string;
  private authToken?: string;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private eventListeners: Map<string, Set<EventCallback>> = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private keepAliveInFlight = false;
  private reconnectAttempts = 0;
  private connectPromise: Promise<void> | null = null;
  private intentionalDisconnect = false;
  private connected = false;
  private authenticated = false;
  private connectResolve?: () => void;
  private connectReject?: (err: Error) => void;

  // H1: Tick stall detection
  private lastTickAt: number | null = null;
  private tickWatchTimer: ReturnType<typeof setInterval> | null = null;
  private readonly TICK_STALL_MS = 90_000; // 3× server tick interval (30s)

  // H2: Sequence gap tracking
  private lastSeq: number | null = null;

  // H3: Reconnect circuit breaker
  private readonly MAX_RECONNECT_ATTEMPTS = 50;
  private readonly CIRCUIT_BREAK_MS = 5 * 60_000; // 5 min cooldown

  // M1: Post-reconnect grace period
  private reconnectedAt: number | null = null;

  // L2: Pending request guard
  private readonly MAX_PENDING_REQUESTS = 200;

  // L1: Connection health metrics
  private metricsFirstConnectedAt: number | null = null;
  private metricsLastConnectedAt: number | null = null;
  private metricsCurrentConnectionStart: number | null = null;
  private metricsTotalReconnects = 0;
  private metricsTotalConnections = 0;
  private metricsTotalConnectionDurationMs = 0;
  private metricsEventsReceived = 0;
  private metricsSequenceGaps = 0;
  private metricsTickStalls = 0;
  private metricsCircuitBreakerTrips = 0;
  // Rolling event throughput: circular buffer of timestamps (last 60s)
  private metricsEventTimestamps: number[] = [];
  private readonly METRICS_THROUGHPUT_WINDOW_MS = 60_000;

  constructor(url = "ws://127.0.0.1:18789", opts?: { authToken?: string }) {
    this.url = url;
    this.authToken = opts?.authToken;
  }

  private startKeepAlive(): void {
    if (this.keepAliveTimer) {return;}
    this.keepAliveTimer = setInterval(() => {
      if (!this.isConnected() || this.keepAliveInFlight) {return;}
      // M1: Skip keep-alive during grace period after reconnect
      if (this.reconnectedAt && Date.now() - this.reconnectedAt < 30_000) {return;}
      this.keepAliveInFlight = true;
      this.call("health", {}, 15_000)
        .catch(() => {
          // Recycle stale sockets to trigger reconnect quickly.
          if (this.intentionalDisconnect) {return;}
          try {
            this.ws?.terminate();
          } catch {
            // Ignore termination errors.
          }
        })
        .finally(() => {
          this.keepAliveInFlight = false;
        });
    }, 20_000);
  }

  // H1: Monitor server tick events for silent connection death
  private startTickWatch(): void {
    this.lastTickAt = Date.now();
    if (this.tickWatchTimer) {clearInterval(this.tickWatchTimer);}
    this.tickWatchTimer = setInterval(() => {
      if (!this.lastTickAt || this.intentionalDisconnect) {return;}
      const gap = Date.now() - this.lastTickAt;
      if (gap > this.TICK_STALL_MS) {
        this.metricsTickStalls++;
        gwLog("warn", "Tick stall detected, recycling connection", {
          stalledMs: gap, threshold: this.TICK_STALL_MS, totalStalls: this.metricsTickStalls,
        });
        try { this.ws?.terminate(); } catch { /* ignore */ }
      }
    }, 30_000);
  }

  private stopTickWatch(): void {
    if (this.tickWatchTimer) {
      clearInterval(this.tickWatchTimer);
      this.tickWatchTimer = null;
    }
    this.lastTickAt = null;
  }

  private stopKeepAlive(): void {
    if (!this.keepAliveTimer) {return;}
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
    this.keepAliveInFlight = false;
  }

  private shouldRetryConnect(error: unknown): boolean {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return (
      message.includes("timeout") ||
      message.includes("closed") ||
      message.includes("websocket is not open")
    );
  }

  private resetSocketState(): void {
    try {
      this.ws?.terminate();
    } catch {
      // Ignore termination errors.
    }
    this.ws = null;
    this.connected = false;
    this.authenticated = false;
    this.stopKeepAlive();
    this.stopTickWatch();
  }

  private shouldRetryRpc(error: unknown): boolean {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return (
      message.includes("websocket connection closed") ||
      message.includes("websocket is not open") ||
      message.includes("rpc timeout") ||
      message.includes("gateway connection timeout")
    );
  }

  // --- Connection with proper Gateway protocol ---

  async connect(retryCount = 0): Promise<void> {
    if (this.authenticated && this.ws?.readyState === WebSocket.OPEN) {return;}
    if (this.connectPromise) {
      try {
        return await this.connectPromise;
      } catch (error) {
        if (retryCount < 1 && this.shouldRetryConnect(error)) {
          this.connectPromise = null;
          this.resetSocketState();
          return this.connect(retryCount + 1);
        }
        throw error;
      }
    }

    this.connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) {return;}
        settled = true;
        this.connectPromise = null;
        if (err) {reject(err);}
        else {resolve();}
      };

      this.connectResolve = () => settle();
      this.connectReject = (err: Error) => settle(err);

      try {
        // If we have a stale socket object, close it before creating a fresh one.
        if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
          try {
            this.ws.terminate();
          } catch {
            // Ignore termination errors.
          }
        }

        this.intentionalDisconnect = false;
        const ws = new WebSocket(this.url, {
          maxPayload: 25 * 1024 * 1024,
        });
        this.ws = ws;

        // M4: 15s to let server-side 10s handshake timeout fire first
        const connectTimeout = setTimeout(() => {
          settle(new Error("Gateway connection timeout (15s)"));
          try {
            ws.close();
          } catch {
            // Ignore close errors.
          }
        }, 15_000);

        ws.on("open", () => {
          this.connected = true;
          // Wait for connect.challenge event from server.
        });

        ws.on("message", (raw: WebSocket.Data) => {
          try {
            const parsed = JSON.parse(raw.toString());
            this.handleMessage(parsed, connectTimeout);
          } catch {
            // Ignore non-JSON frames.
          }
        });

        ws.on("close", () => {
          // L1: Record connection duration
          if (this.metricsCurrentConnectionStart) {
            this.metricsTotalConnectionDurationMs += Date.now() - this.metricsCurrentConnectionStart;
            this.metricsCurrentConnectionStart = null;
          }
          this.connected = false;
          this.authenticated = false;
          this.stopKeepAlive();
          this.stopTickWatch();
          if (this.ws === ws) {this.ws = null;}
          clearTimeout(connectTimeout);
          // Reject all pending requests to prevent UI hangs.
          for (const pending of this.pendingRequests.values()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error("WebSocket connection closed"));
          }
          this.pendingRequests.clear();

          if (!settled) {
            settle(new Error("WebSocket connection closed"));
          }

          if (!this.intentionalDisconnect) {
            this.scheduleReconnect();
          }
        });

        ws.on("error", (err) => {
          clearTimeout(connectTimeout);
          if (!this.authenticated) {
            settle(err instanceof Error ? err : new Error(String(err)));
          }
        });
      } catch (err) {
        settle(err instanceof Error ? err : new Error(String(err)));
      }
    });

    try {
      await this.connectPromise;
    } catch (error) {
      if (retryCount < 1 && this.shouldRetryConnect(error)) {
        this.connectPromise = null;
        this.resetSocketState();
        return this.connect(retryCount + 1);
      }
      throw error;
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {clearTimeout(this.reconnectTimer);}
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    if (this.ws) {
      this.intentionalDisconnect = true;
      this.ws.close();
      this.ws = null;
    }
    this.stopKeepAlive();
    this.stopTickWatch();
    this.connected = false;
    this.authenticated = false;
  }

  isConnected(): boolean {
    return (
      this.authenticated && this.ws?.readyState === WebSocket.OPEN
    );
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {return;}

    // H3: Circuit breaker — after too many attempts, enter long cooldown
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      this.metricsCircuitBreakerTrips++;
      gwLog("error", "Circuit breaker: too many reconnect attempts, cooling down", {
        attempts: this.reconnectAttempts, cooldownMs: this.CIRCUIT_BREAK_MS,
      });
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.reconnectAttempts = 0;
        gwLog("info", "Circuit breaker reset, attempting reconnect");
        this.connect().catch(() => { });
      }, this.CIRCUIT_BREAK_MS);
      return;
    }

    // Exponential backoff with jitter to avoid reconnect storms.
    const baseMs = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
    const jitterMs = Math.floor(Math.random() * 500);
    const delayMs = baseMs + jitterMs;
    this.reconnectAttempts++;
    this.metricsTotalReconnects++;

    gwLog("info", "Scheduling reconnect", { attempt: this.reconnectAttempts, delayMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => { });
    }, delayMs);
  }

  // --- Protocol handling ---

  private handleMessage(
    msg: Record<string, unknown>,
    connectTimeout?: ReturnType<typeof setTimeout>
  ): void {
    // Event frame
    if (msg.type === "event") {
      const evt = msg as unknown as EventFrame;

      // Handle connect.challenge - send connect request
      if (evt.event === "connect.challenge") {
        const payload = evt.payload as { nonce?: string } | undefined;
        const nonce = payload?.nonce;
        this.sendConnectRequest(nonce, connectTimeout);
        return;
      }

      // H1: Track tick events for stall detection
      if (evt.event === "tick") {
        this.lastTickAt = Date.now();
      }

      // L1: Event throughput tracking
      this.metricsEventsReceived++;
      const now = Date.now();
      this.metricsEventTimestamps.push(now);
      // Trim timestamps outside the rolling window
      const cutoff = now - this.METRICS_THROUGHPUT_WINDOW_MS;
      while (this.metricsEventTimestamps.length > 0 && this.metricsEventTimestamps[0] < cutoff) {
        this.metricsEventTimestamps.shift();
      }

      // H2: Detect event sequence gaps
      if (typeof evt.seq === "number") {
        if (this.lastSeq !== null && evt.seq > this.lastSeq + 1) {
          this.metricsSequenceGaps++;
          gwLog("warn", "Event sequence gap detected", {
            expected: this.lastSeq + 1, received: evt.seq,
            missed: evt.seq - this.lastSeq - 1, totalGaps: this.metricsSequenceGaps,
          });
        }
        this.lastSeq = evt.seq;
      }

      // Broadcast to event listeners
      const listeners = this.eventListeners.get(evt.event);
      if (listeners) {
        for (const cb of listeners) {
          try { cb(evt.payload ?? evt); } catch { /* ignore */ }
        }
      }
      const wildcardListeners = this.eventListeners.get("*");
      if (wildcardListeners) {
        for (const cb of wildcardListeners) {
          try { cb({ event: evt.event, payload: evt.payload, seq: evt.seq }); } catch { /* ignore */ }
        }
      }
      return;
    }

    // Response frame
    if (msg.type === "res") {
      const res = msg as unknown as ResponseFrame;
      const pending = this.pendingRequests.get(res.id);
      if (!pending) {return;}

      // The connect handshake sends an "accepted" then a final response.
      // Only skip "accepted" for the connect method — all other RPCs should resolve immediately.
      if (
        res.ok &&
        typeof res.payload === "object" &&
        res.payload !== null &&
        (res.payload as Record<string, unknown>).status === "accepted" &&
        pending.method === "connect"
      ) {
        return;
      }

      this.pendingRequests.delete(res.id);
      clearTimeout(pending.timeout);

      if (res.ok) {
        pending.resolve(res.payload);
      } else {
        pending.reject(
          new Error(res.error?.message ?? "Unknown gateway error")
        );
      }
    }
  }

  private sendConnectRequest(
    nonce?: string,
    connectTimeout?: ReturnType<typeof setTimeout>
  ): void {
    const id = randomUUID();
    const clientId = "gateway-client";
    const clientMode = "backend";
    const role = "operator";
    const scopes = ["operator.admin"];
    const signedAtMs = Date.now();

    // Build signed device identity
    const sigMsg = buildSigningMessage({
      deviceId: deviceIdentity.deviceId,
      clientId,
      clientMode,
      role,
      scopes,
      signedAtMs,
      token: this.authToken ?? "",
      nonce,
    });
    const signature = signDeviceMessage(deviceIdentity, sigMsg);

    const frame: RequestFrame = {
      type: "req",
      id,
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: clientId,
          displayName: "OpenClaw Dashboard",
          version: "1.0.0",
          platform: "node",
          mode: clientMode,
        },
        caps: [],
        auth: this.authToken
          ? { token: this.authToken }
          : undefined,
        role,
        scopes,
        device: {
          id: deviceIdentity.deviceId,
          publicKey: deviceIdentity.publicKey,
          signature,
          signedAt: signedAtMs,
          nonce,
        },
      },
    };

    // Register pending for the connect response
    const pending: PendingRequest = {
      resolve: () => {
        if (connectTimeout) {clearTimeout(connectTimeout);}
        this.authenticated = true;
        this.reconnectAttempts = 0;
        this.reconnectedAt = Date.now(); // M1: track for grace period
        this.lastSeq = null; // H2: reset sequence on fresh connection
        // L1: Track connection metrics
        const now = Date.now();
        this.metricsTotalConnections++;
        this.metricsCurrentConnectionStart = now;
        this.metricsLastConnectedAt = now;
        if (!this.metricsFirstConnectedAt) {this.metricsFirstConnectedAt = now;}
        this.startKeepAlive();
        this.startTickWatch(); // H1: begin tick monitoring
        gwLog("info", "Connected to gateway", { connectionNumber: this.metricsTotalConnections });
        this.connectResolve?.();
      },
      reject: (err: unknown) => {
        if (connectTimeout) {clearTimeout(connectTimeout);}
        this.connectReject?.(
          err instanceof Error ? err : new Error(String(err))
        );
      },
      timeout: setTimeout(() => {
        this.pendingRequests.delete(id);
        this.connectReject?.(new Error("Connect handshake timeout"));
      }, 10000),
      method: "connect",
    };

    this.pendingRequests.set(id, pending);
    this.ws?.send(JSON.stringify(frame));
  }

  // --- JSON-RPC calls ---

  async call(
    method: string,
    params?: unknown,
    timeoutMs = 30000,
    retryCount = 0
  ): Promise<unknown> {
    try {
      if (!this.isConnected()) {
        await this.connect();
      }

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        throw new Error("WebSocket is not open");
      }

      // L2: Guard against unbounded pending request accumulation
      if (this.pendingRequests.size >= this.MAX_PENDING_REQUESTS) {
        throw new Error(
          `Too many pending requests (${this.pendingRequests.size}), gateway may be unresponsive`
        );
      }

      const id = randomUUID();
      const frame: RequestFrame = {
        type: "req",
        id,
        method,
        params: params ?? {},
      };

      return await new Promise((resolve, reject) => {
        // L3: Enhanced timeout message with context
        const timeout = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(
            `RPC timeout: ${method} after ${timeoutMs}ms (connected: ${this.isConnected()}, pending: ${this.pendingRequests.size})`
          ));
        }, timeoutMs);

        this.pendingRequests.set(id, { resolve, reject, timeout, method });
        try {
          this.ws!.send(JSON.stringify(frame));
        } catch (error) {
          clearTimeout(timeout);
          this.pendingRequests.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    } catch (error) {
      if (retryCount < 1 && this.shouldRetryRpc(error)) {
        this.resetSocketState();
        return this.call(method, params, timeoutMs, retryCount + 1);
      }
      throw error;
    }
  }

  // --- Events ---

  onEvent(type: string, callback: EventCallback): () => void {
    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, new Set());
    }
    this.eventListeners.get(type)!.add(callback);
    return () => {
      this.eventListeners.get(type)?.delete(callback);
    };
  }

  // --- Agents ---

  async listAgents(): Promise<OpenClawAgent[]> {
    const result = (await this.call("agents.list", {})) as {
      agents?: OpenClawAgent[];
    };
    return result?.agents ?? [];
  }

  /** Fetch the current config base hash required for mutating calls. */
  async getConfigHash(): Promise<string> {
    const result = (await this.configGet()) as Record<string, unknown>;
    // The RPC response may have hash at top level or nested under "config"
    const hash =
      (result?.hash as string) ??
      ((result?.config as Record<string, unknown>)?.hash as string);
    if (!hash) {throw new Error("Could not retrieve config hash from gateway");}
    return hash;
  }

  async createAgent(params: {
    name: string;
    workspace: string;
    emoji?: string;
    avatar?: string;
  }): Promise<unknown> {
    const baseHash = await this.getConfigHash();
    return this.call("agents.create", { ...params, baseHash });
  }

  async updateAgent(params: {
    agentId: string;
    patch: Record<string, unknown>;
  }): Promise<unknown> {
    const baseHash = await this.getConfigHash();
    return this.call("agents.update", { ...params, baseHash });
  }

  async deleteAgent(agentId: string): Promise<unknown> {
    return this.call("agents.delete", { agentId });
  }

  async getAgentFile(agentId: string, name: string): Promise<string> {
    const result = (await this.call("agents.files.get", {
      agentId,
      name,
    })) as { file?: { content?: string } };
    return result?.file?.content ?? "";
  }

  async setAgentFile(
    agentId: string,
    name: string,
    content: string
  ): Promise<unknown> {
    return this.call("agents.files.set", { agentId, name, content });
  }

  // --- Chat ---

  async sendMessage(
    sessionKey: string,
    message: string,
    opts?: { idempotencyKey?: string }
  ): Promise<unknown> {
    return this.call("chat.send", {
      sessionKey,
      message,
      idempotencyKey: opts?.idempotencyKey ?? randomUUID(),
    });
  }

  async getChatHistory(
    sessionKey: string,
    opts?: { limit?: number }
  ): Promise<ChatMessage[]> {
    const result = (await this.call("chat.history", {
      sessionKey,
      ...opts,
    })) as { messages?: ChatMessage[] };
    return result?.messages ?? [];
  }

  async searchChat(params: {
    query: string;
    limit?: number;
    offset?: number;
    sessionKey?: string;
    channel?: string;
    model?: string;
    agentId?: string;
    from?: number;
    to?: number;
    tags?: string[];
  }): Promise<ChatSearchResult> {
    return (await this.call("chat.search", params)) as ChatSearchResult;
  }

  async getChatAnalytics(params?: {
    sessionKey?: string;
    channel?: string;
    model?: string;
    agentId?: string;
    from?: number;
    to?: number;
  }): Promise<ChatAnalyticsResult> {
    return (await this.call("chat.analytics", params ?? {})) as ChatAnalyticsResult;
  }

  async abortChat(sessionKey: string, runId?: string): Promise<unknown> {
    return this.call("chat.abort", { sessionKey, runId });
  }

  // --- Sessions ---

  async listSessions(opts?: {
    agentId?: string;
  }): Promise<OpenClawSession[]> {
    const result = (await this.call("sessions.list", opts ?? {})) as {
      sessions?: OpenClawSession[];
    };
    return result?.sessions ?? [];
  }

  async getSessionTags(key: string): Promise<string[]> {
    const result = (await this.call("sessions.tags", { key })) as { tags?: string[] };
    return Array.isArray(result?.tags) ? result.tags : [];
  }

  async searchSessions(params: {
    query: string;
    limit?: number;
    offset?: number;
    channel?: string;
    agentId?: string;
    from?: number;
    to?: number;
    tags?: string[];
  }): Promise<SessionsSearchResult> {
    return (await this.call("sessions.search", params)) as SessionsSearchResult;
  }

  async previewSessions(keys: string[]): Promise<unknown> {
    return this.call("sessions.preview", { keys });
  }

  async resetSession(key: string): Promise<unknown> {
    return this.call("sessions.reset", { key });
  }

  async deleteSession(key: string): Promise<unknown> {
    return this.call("sessions.delete", { key });
  }

  async patchSession(
    key: string,
    patch: { model?: string | null;[k: string]: unknown }
  ): Promise<unknown> {
    return this.call("sessions.patch", { key, ...patch });
  }

  // --- Cron ---

  async listCronJobs(): Promise<OpenClawCronJob[]> {
    const result = (await this.call("cron.list", {
      includeDisabled: true,
    })) as { jobs?: OpenClawCronJob[] };
    return result?.jobs ?? [];
  }

  async addCronJob(params: {
    prompt: string;
    schedule: string;
    agentId?: string;
    sessionKey?: string;
    enabled?: boolean;
  }): Promise<OpenClawCronJob> {
    return (await this.call("cron.add", params)) as OpenClawCronJob;
  }

  async updateCronJob(
    id: string,
    patch: Partial<{
      prompt: string;
      schedule: string;
      enabled: boolean;
    }>
  ): Promise<OpenClawCronJob> {
    return (await this.call("cron.update", {
      id,
      patch,
    })) as OpenClawCronJob;
  }

  async removeCronJob(id: string): Promise<unknown> {
    return this.call("cron.remove", { id });
  }

  async runCronJob(id: string, mode?: "due" | "force"): Promise<unknown> {
    return this.call("cron.run", { id, mode: mode ?? "force" });
  }

  // --- System ---

  async health(): Promise<unknown> {
    return this.call("health", {});
  }

  async status(): Promise<unknown> {
    return this.call("status", {});
  }

  async getUsage(): Promise<unknown> {
    return this.call("usage.status", {});
  }

  async listModels(): Promise<unknown> {
    return this.call("models.list", {});
  }

  // --- Send to agent session (the `send` method) ---

  async sendToAgent(params: {
    message: string;
    session?: string;
    agentId?: string;
  }): Promise<unknown> {
    return this.call("send", params);
  }

  // --- Usage & Costs ---

  async getUsageCost(params?: { days?: number }): Promise<unknown> {
    return this.call("usage.cost", params ?? {});
  }

  // --- TTS ---

  async ttsStatus(): Promise<unknown> {
    return this.call("tts.status", {});
  }

  async ttsProviders(): Promise<unknown> {
    return this.call("tts.providers", {});
  }

  async ttsConvert(params: {
    text: string;
    provider?: string;
  }): Promise<unknown> {
    return this.call("tts.convert", params);
  }

  // --- Config ---

  async configGet(): Promise<unknown> {
    return this.call("config.get", {});
  }

  async configSchema(): Promise<unknown> {
    return this.call("config.schema", {});
  }

  async configPatch(patch: Record<string, unknown>, baseHash?: string): Promise<unknown> {
    return this.call("config.patch", { patch, baseHash });
  }

  // --- Exec Approvals ---

  async getExecApprovals(): Promise<unknown> {
    return this.call("exec.approvals.get", {});
  }

  async setExecApprovals(params: Record<string, unknown>): Promise<unknown> {
    return this.call("exec.approvals.set", params);
  }

  async resolveExecApproval(params: {
    id: string;
    decision: "approve" | "reject" | "allow-once" | "allow-always" | "deny";
  }): Promise<unknown> {
    return this.call("exec.approval.resolve", params);
  }

  // --- Nodes ---

  async listNodes(): Promise<unknown> {
    return this.call("node.list", {});
  }

  async describeNode(nodeId: string): Promise<unknown> {
    return this.call("node.describe", { nodeId });
  }

  // --- Logs ---

  async tailLogs(): Promise<unknown> {
    return this.call("logs.tail", {});
  }

  // --- Channels ---

  async channelsStatus(): Promise<unknown> {
    return this.call("channels.status", {});
  }

  // --- Skills ---

  async skillsStatus(): Promise<unknown> {
    return this.call("skills.status", {});
  }

  // --- Cron Runs ---

  async cronRuns(id: string): Promise<unknown> {
    return this.call("cron.runs", { id });
  }

  async cronStatus(): Promise<unknown> {
    return this.call("cron.status", {});
  }
  // L1: Public connection health metrics API
  getConnectionMetrics(): ConnectionMetrics {
    const now = Date.now();
    const uptimeMs = this.metricsCurrentConnectionStart
      ? now - this.metricsCurrentConnectionStart
      : 0;
    const totalDuration = this.metricsTotalConnectionDurationMs + uptimeMs;
    const avgConnectionDurationMs = this.metricsTotalConnections > 0
      ? Math.round(totalDuration / this.metricsTotalConnections)
      : 0;

    // Trim stale timestamps for accurate throughput
    const cutoff = now - this.METRICS_THROUGHPUT_WINDOW_MS;
    while (this.metricsEventTimestamps.length > 0 && this.metricsEventTimestamps[0] < cutoff) {
      this.metricsEventTimestamps.shift();
    }
    const windowSeconds = this.METRICS_THROUGHPUT_WINDOW_MS / 1000;
    const eventsPerSecond = Math.round((this.metricsEventTimestamps.length / windowSeconds) * 100) / 100;

    return {
      connected: this.isConnected(),
      firstConnectedAt: this.metricsFirstConnectedAt
        ? new Date(this.metricsFirstConnectedAt).toISOString()
        : null,
      lastConnectedAt: this.metricsLastConnectedAt
        ? new Date(this.metricsLastConnectedAt).toISOString()
        : null,
      uptimeMs,
      totalReconnects: this.metricsTotalReconnects,
      totalConnections: this.metricsTotalConnections,
      avgConnectionDurationMs,
      eventsReceived: this.metricsEventsReceived,
      eventsPerSecond,
      sequenceGapsDetected: this.metricsSequenceGaps,
      tickStallsDetected: this.metricsTickStalls,
      circuitBreakerTrips: this.metricsCircuitBreakerTrips,
      pendingRequests: this.pendingRequests.size,
    };
  }
}

// Singleton for server-side usage — survives HMR via globalThis (M2)
const _clientKey = "__openclawClientInstance";

export function getOpenClawClient(): OpenClawClient {
  const cached = (globalThis as Record<string, unknown>)[_clientKey] as OpenClawClient | undefined;
  if (cached) {return cached;}
  const url =
    process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789";
  const authToken = process.env.OPENCLAW_AUTH_TOKEN;
  const client = new OpenClawClient(url, { authToken });
  (globalThis as Record<string, unknown>)[_clientKey] = client;
  return client;
}
