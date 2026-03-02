/**
 * ConnectionManager -- orchestrates the GramJS client lifecycle with
 * automatic reconnection and health reporting.
 *
 * Wraps UserbotClient + SessionStore into a single stateful controller
 * that emits typed events for upstream consumption (channel adapter, UI).
 */

import { EventEmitter } from "node:events";
import { UserbotClient } from "./client.js";
import { UserbotAuthError } from "./errors.js";
import { SessionStore } from "./session-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConnectionConfig {
  apiId: number;
  apiHash: string;
  /** Used for session file naming (maps to SessionStore accountId). */
  accountId: string;
  reconnect?: {
    /** Max reconnect attempts. -1 = infinite (default). */
    maxAttempts?: number;
    /** Emit "alertNeeded" after this many consecutive failures (default 3). */
    alertAfterFailures?: number;
  };
}

export interface ConnectionHealth {
  connected: boolean;
  latencyMs: number;
  uptimeMs: number;
  reconnects: number;
  dcId?: number;
  username?: string;
  userId?: number;
}

export type ConnectionEvent =
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "authError"
  | "alertNeeded";

// ---------------------------------------------------------------------------
// ConnectionManager
// ---------------------------------------------------------------------------

export class ConnectionManager extends EventEmitter {
  private client: UserbotClient | null = null;
  private sessionStore: SessionStore;
  private config: ConnectionConfig;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectedAt: number = 0;
  private reconnectCount: number = 0;
  private consecutiveFailures: number = 0;
  private stopped: boolean = false;
  private username?: string;
  private userId?: number;

  constructor(config: ConnectionConfig, sessionStore?: SessionStore) {
    super();
    this.config = config;
    this.sessionStore = sessionStore ?? new SessionStore();
  }

  /**
   * Start the connection lifecycle.
   *
   * Loads the persisted session from disk, creates a UserbotClient, and
   * attempts to connect. Returns `true` on successful connection, `false`
   * if there is no session or the connection fails (reconnection is
   * scheduled automatically for transient errors).
   */
  async start(): Promise<boolean> {
    this.stopped = false;

    const session = await this.sessionStore.load(this.config.accountId);
    if (!session) {
      this.emit("disconnected", { reason: "no-session" });
      return false;
    }

    this.client = new UserbotClient({
      apiId: this.config.apiId,
      apiHash: this.config.apiHash,
      session,
    });

    try {
      await this.client.connect();
      const me = await this.client.getMe();
      this.username = me.username ?? undefined;
      this.userId = typeof me.id === "bigint" ? Number(me.id) : (me.id as number);
      this.connectedAt = Date.now();
      this.consecutiveFailures = 0;
      this.emit("connected", { username: this.username, userId: this.userId });
      return true;
    } catch (error) {
      if (error instanceof UserbotAuthError) {
        this.emit("authError", { error });
        return false;
      }
      // Transient error -- schedule reconnection
      this.scheduleReconnect();
      return false;
    }
  }

  /** Gracefully stop: persist session, disconnect, clear timers. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearReconnectTimer();

    if (this.client?.isConnected()) {
      const sessionString = this.client.getSessionString();
      if (sessionString) {
        await this.sessionStore.save(this.config.accountId, sessionString);
      }
      await this.client.disconnect();
    }

    this.client = null;
    this.connectedAt = 0;
    this.emit("disconnected", { reason: "stopped" });
  }

  /** Stop then start again. */
  async restart(): Promise<boolean> {
    await this.stop();
    return this.start();
  }

  /** Access the underlying UserbotClient (null when disconnected). */
  getClient(): UserbotClient | null {
    return this.client;
  }

  /** Snapshot of connection health metrics. */
  health(): ConnectionHealth {
    return {
      connected: this.client?.isConnected() ?? false,
      latencyMs: 0, // placeholder -- can be enhanced with MTProto ping later
      uptimeMs: this.connectedAt > 0 ? Date.now() - this.connectedAt : 0,
      reconnects: this.reconnectCount,
      username: this.username,
      userId: this.userId,
    };
  }

  // -------------------------------------------------------------------------
  // Reconnection
  // -------------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.stopped) return;

    this.consecutiveFailures++;

    const alertAfter = this.config.reconnect?.alertAfterFailures ?? 3;
    if (this.consecutiveFailures >= alertAfter) {
      this.emit("alertNeeded", { failures: this.consecutiveFailures });
    }

    const maxAttempts = this.config.reconnect?.maxAttempts ?? -1;
    if (maxAttempts !== -1 && this.reconnectCount >= maxAttempts) {
      this.emit("disconnected", { reason: "max-retries" });
      return;
    }

    const delay = this.getReconnectDelay();
    this.emit("reconnecting", { attempt: this.consecutiveFailures, delayMs: delay });

    this.reconnectTimer = setTimeout(async () => {
      await this.attemptReconnect();
    }, delay);
  }

  private async attemptReconnect(): Promise<void> {
    if (this.stopped) return;

    this.reconnectCount++;

    try {
      if (this.client) {
        await this.client.connect();
        const me = await this.client.getMe();
        this.username = me.username ?? undefined;
        this.userId = typeof me.id === "bigint" ? Number(me.id) : (me.id as number);
        this.connectedAt = Date.now();
        this.consecutiveFailures = 0;
        this.emit("connected", { username: this.username, userId: this.userId });
      }
    } catch (error) {
      if (error instanceof UserbotAuthError) {
        this.emit("authError", { error });
        return; // Don't retry auth errors
      }
      this.scheduleReconnect();
    }
  }

  /**
   * Exponential-ish backoff:
   *  - attempt 1: immediate (0 ms)
   *  - attempts 2-3: 5 s
   *  - attempts 4-6: 30 s
   *  - attempts 7+: 2 min
   */
  private getReconnectDelay(): number {
    const attempt = this.consecutiveFailures;
    if (attempt <= 1) return 0;
    if (attempt <= 3) return 5_000;
    if (attempt <= 6) return 30_000;
    return 120_000;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
