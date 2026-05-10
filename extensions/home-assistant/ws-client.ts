/**
 * Long-lived Home Assistant WebSocket client.
 *
 * Lifecycle (HA WS protocol):
 *   1. open                                  -> CONNECTING
 *   2. server: { type: "auth_required" }     -> AUTHENTICATING
 *      client: { type: "auth", access_token: ... }
 *   3. server: { type: "auth_ok" }
 *      client: { id, type: "subscribe_events", event_type: "state_changed" }
 *   4. server: { id, type: "result", success: true } -> SUBSCRIBED
 *   5. server: { id, type: "event", event: { event_type, data } }
 *
 * After SUBSCRIBED, periodic { id, type: "ping" } / { id, type: "pong" } at
 * the application layer guards against silent half-open sockets.
 *
 * Boundaries respected by this module:
 *   - No core internals are imported. The WS factory, store, and clock are
 *     injected so tests can drive the lifecycle deterministically without a
 *     real socket or real timers.
 *   - Allow-list filtering happens in `state-store.ts`. This client does not
 *     re-implement it; it forwards events as-is.
 *
 * What this module does NOT do (deferred per the kiosk plan):
 *   - service_call dispatch -- belongs to the gateway bridge in Unit 4.
 *   - deny-list enforcement -- belongs to `allowlist.ts` in Unit 3.
 */

import type { HomeAssistantStateStore } from "./state-store.js";

// -- WebSocket-like contract --------------------------------------------------

/**
 * Subset of the WHATWG WebSocket interface that this client uses. Both the
 * standard browser WebSocket and a `ws` package socket satisfy this; tests
 * supply a fake implementation. The numeric readyState constants follow the
 * standard (0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED).
 */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
}

export type WebSocketLikeFactory = (url: string) => WebSocketLike;

// -- Connection state machine -------------------------------------------------

export type ConnectionState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "subscribed"
  | "degraded"
  | "disconnected";

export type StateChangeListener = (state: ConnectionState) => void;
export type Unsubscribe = () => void;

export type LogLevel = "info" | "warn" | "error";
export type LogEntry = {
  level: LogLevel;
  message: string;
  data?: unknown;
};
export type Logger = (entry: LogEntry) => void;

// -- Options -------------------------------------------------------------------

export type HomeAssistantClientOptions = {
  url: string;
  token: string;
  store: HomeAssistantStateStore;
  webSocketFactory: WebSocketLikeFactory;
  /** Reconnect backoff knobs. Defaults: base 1s, cap 30s. */
  reconnect?: { baseDelayMs?: number; maxDelayMs?: number };
  /** Heartbeat knobs. Defaults: ping every 30s, pong timeout 10s. */
  heartbeat?: { intervalMs?: number; timeoutMs?: number };
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  logger?: Logger;
};

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10000;

// -- HA WS message shapes (only what we read; everything else is opaque) ----

type HaMessage = Record<string, unknown> & { type?: string; id?: number };

type HaStateAttributes = Record<string, unknown>;

type HaEntityState = {
  entity_id: string;
  state: string;
  attributes: HaStateAttributes;
  last_changed?: string;
  last_updated?: string;
};

type HaStateChangedData = {
  entity_id: string;
  old_state: HaEntityState | null;
  new_state: HaEntityState | null;
};

// -- Implementation ----------------------------------------------------------

export class HomeAssistantClient {
  state: ConnectionState = "idle";

  private readonly options: HomeAssistantClientOptions;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly logger: Logger;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;

  private socket: WebSocketLike | null = null;
  private nextCommandId = 1;
  private subscribeId: number | null = null;
  private outstandingPing: { id: number; timeoutHandle: unknown } | null = null;
  private heartbeatHandle: unknown = null;
  private reconnectHandle: unknown = null;
  private reconnectAttempt = 0;
  private hasEverSubscribed = false;
  private stopped = false;

  private readonly stateListeners = new Set<StateChangeListener>();

  constructor(options: HomeAssistantClientOptions) {
    this.options = options;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn =
      options.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.logger = options.logger ?? (() => undefined);
    this.baseDelayMs = options.reconnect?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.reconnect?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.heartbeatIntervalMs = options.heartbeat?.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = options.heartbeat?.timeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  }

  start(): void {
    if (this.stopped) {
      return;
    }
    if (this.state !== "idle" && this.state !== "disconnected" && this.state !== "degraded") {
      return;
    }
    this.openSocket();
  }

  stop(): void {
    this.stopped = true;
    this.cancelReconnect();
    this.cancelHeartbeat();
    this.detachAndClose();
    this.transition("disconnected");
  }

  onStateChange(listener: StateChangeListener): Unsubscribe {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /** Visible for tests; pure function over the configured backoff bounds. */
  computeReconnectDelay(attempt: number): number {
    if (attempt <= 0) {
      return 0;
    }
    const exp = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
    return Math.min(this.maxDelayMs, exp);
  }

  // -- internal ------------------------------------------------------------

  private openSocket(): void {
    if (this.stopped) {
      return;
    }
    this.cancelReconnect();
    this.cancelHeartbeat();

    const ws = this.options.webSocketFactory(this.options.url);
    this.socket = ws;
    this.transition("connecting");

    ws.onopen = () => {
      // No state transition on raw open -- HA sends auth_required next.
      this.logger({ level: "info", message: "ha-ws.open" });
    };
    ws.onmessage = (ev) => this.handleMessage(ev);
    ws.onerror = (ev) => {
      this.logger({ level: "warn", message: "ha-ws.socket-error", data: ev });
    };
    ws.onclose = (ev) => this.handleClose(ev);
  }

  private handleMessage(ev: { data: unknown }): void {
    const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
    let msg: HaMessage;
    try {
      msg = JSON.parse(raw) as HaMessage;
    } catch (cause) {
      this.logger({
        level: "warn",
        message: "ha-ws.parse-failed",
        data: { error: String(cause), raw: raw.slice(0, 200) },
      });
      return;
    }

    if (typeof msg !== "object" || msg === null) {
      this.logger({ level: "warn", message: "ha-ws.unexpected-shape", data: raw.slice(0, 200) });
      return;
    }

    switch (msg.type) {
      case "auth_required":
        this.handleAuthRequired();
        return;
      case "auth_ok":
        this.handleAuthOk();
        return;
      case "auth_invalid":
        this.handleAuthInvalid(msg);
        return;
      case "result":
        this.handleResult(msg);
        return;
      case "event":
        this.handleEvent(msg);
        return;
      case "pong":
        this.handlePong(msg);
        return;
      default:
        this.logger({
          level: "warn",
          message: "ha-ws.unknown-type",
          data: { type: msg.type ?? null },
        });
    }
  }

  private handleAuthRequired(): void {
    this.transition("authenticating");
    this.send({ type: "auth", access_token: this.options.token });
  }

  private handleAuthOk(): void {
    // Subscribe to state_changed events. The plan leaves the choice between
    // subscribe_events and subscribe_entities to impl time; subscribe_events
    // is simpler and adequate for household-scale entity counts.
    const id = this.takeCommandId();
    this.subscribeId = id;
    this.send({ id, type: "subscribe_events", event_type: "state_changed" });
  }

  private handleAuthInvalid(msg: HaMessage): void {
    this.logger({
      level: "error",
      message: "ha-ws.auth-invalid",
      data: { detail: msg.message ?? null },
    });
    // No reconnect: token won't fix itself. Operator must rotate credentials.
    this.cancelReconnect();
    this.cancelHeartbeat();
    this.detachAndClose();
    this.transition("degraded");
  }

  private handleResult(msg: HaMessage): void {
    if (this.subscribeId !== null && msg.id === this.subscribeId) {
      const success = msg.success === true;
      if (!success) {
        this.logger({ level: "error", message: "ha-ws.subscribe-failed", data: msg });
        this.degradeAndReconnect();
        return;
      }
      this.subscribeId = null;
      // On every resubscribe except the very first, flush stale state so the
      // store mirrors HA again from a known-empty starting point. Resubscribe
      // happens after a connection drop, where the kiosk plan calls out
      // "fresh subscribe" semantics.
      if (this.hasEverSubscribed) {
        this.options.store.reset();
      }
      this.hasEverSubscribed = true;
      this.reconnectAttempt = 0;
      this.transition("subscribed");
      this.scheduleHeartbeat();
    }
  }

  private handleEvent(msg: HaMessage): void {
    const event = (msg as { event?: { event_type?: string; data?: unknown } }).event;
    if (!event || event.event_type !== "state_changed") {
      return;
    }
    const data = event.data as HaStateChangedData | undefined;
    if (!data || typeof data.entity_id !== "string") {
      this.logger({ level: "warn", message: "ha-ws.bad-event-data" });
      return;
    }
    this.options.store.applyStateChanged({
      entity_id: data.entity_id,
      old_state: data.old_state ?? null,
      new_state: data.new_state ?? null,
    });
  }

  private handlePong(msg: HaMessage): void {
    if (!this.outstandingPing) {
      return;
    }
    if (msg.id !== this.outstandingPing.id) {
      this.logger({ level: "warn", message: "ha-ws.pong-id-mismatch" });
      return;
    }
    this.clearTimeoutFn(this.outstandingPing.timeoutHandle);
    this.outstandingPing = null;
    this.scheduleHeartbeat();
  }

  private handleClose(_ev: { code?: number; reason?: string }): void {
    // Server-initiated or network-initiated close. Closes we initiate
    // ourselves go through detachAndClose which detaches handlers first, so
    // this branch only fires for unexpected drops.
    this.cancelHeartbeat();
    this.socket = null;
    if (this.stopped) {
      this.transition("disconnected");
      return;
    }
    this.transition("degraded");
    this.scheduleReconnect();
  }

  private degradeAndReconnect(): void {
    this.cancelHeartbeat();
    this.detachAndClose();
    this.transition("degraded");
    this.scheduleReconnect();
  }

  private detachAndClose(): void {
    const sock = this.socket;
    this.socket = null;
    if (!sock) {
      return;
    }
    sock.onopen = null;
    sock.onmessage = null;
    sock.onerror = null;
    sock.onclose = null;
    try {
      sock.close();
    } catch (cause) {
      this.logger({ level: "warn", message: "ha-ws.close-failed", data: cause });
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    this.cancelReconnect();
    this.reconnectAttempt += 1;
    const delay = this.computeReconnectDelay(this.reconnectAttempt);
    this.logger({
      level: "info",
      message: "ha-ws.reconnect-scheduled",
      data: { attempt: this.reconnectAttempt, delayMs: delay },
    });
    this.reconnectHandle = this.setTimeoutFn(() => {
      this.reconnectHandle = null;
      this.openSocket();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectHandle) {
      this.clearTimeoutFn(this.reconnectHandle);
      this.reconnectHandle = null;
    }
  }

  private scheduleHeartbeat(): void {
    this.cancelHeartbeat();
    if (this.state !== "subscribed") {
      return;
    }
    this.heartbeatHandle = this.setTimeoutFn(() => {
      this.heartbeatHandle = null;
      this.sendPing();
    }, this.heartbeatIntervalMs);
  }

  private cancelHeartbeat(): void {
    if (this.heartbeatHandle) {
      this.clearTimeoutFn(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
    if (this.outstandingPing) {
      this.clearTimeoutFn(this.outstandingPing.timeoutHandle);
      this.outstandingPing = null;
    }
  }

  private sendPing(): void {
    if (this.state !== "subscribed" || !this.socket) {
      return;
    }
    const id = this.takeCommandId();
    this.send({ id, type: "ping" });
    const timeoutHandle = this.setTimeoutFn(() => {
      this.logger({
        level: "warn",
        message: "ha-ws.ping-timeout",
        data: { pingId: id },
      });
      this.outstandingPing = null;
      this.degradeAndReconnect();
    }, this.heartbeatTimeoutMs);
    this.outstandingPing = { id, timeoutHandle };
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.socket) {
      return;
    }
    try {
      this.socket.send(JSON.stringify(payload));
    } catch (cause) {
      this.logger({ level: "warn", message: "ha-ws.send-failed", data: cause });
    }
  }

  private takeCommandId(): number {
    return this.nextCommandId++;
  }

  private transition(next: ConnectionState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    for (const listener of this.stateListeners) {
      try {
        listener(next);
      } catch (cause) {
        this.logger({ level: "warn", message: "ha-ws.state-listener-failed", data: cause });
      }
    }
  }
}
