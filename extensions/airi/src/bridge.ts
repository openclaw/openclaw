/**
 * AIRI Bridge — WebSocket client connecting OpenClaw gateway
 * to an AIRI avatar frontend for real-time avatar control.
 */

import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import type { AiriConfig } from "./config.js";
import type {
  AiriInboundMessage,
  AiriOutboundMessage,
} from "./protocol.js";
import { isAiriInboundMessage } from "./protocol.js";

export type BridgeState = "disconnected" | "connecting" | "connected";

export type BridgeEvents = {
  connected: [];
  disconnected: [code: number, reason: string];
  message: [msg: AiriInboundMessage];
  error: [err: Error];
  stateChange: [state: BridgeState];
};

export class AiriBridge extends EventEmitter<BridgeEvents> {
  private ws: WebSocket | null = null;
  private state: BridgeState = "disconnected";
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private config: AiriConfig,
    private logger: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
      debug?: (msg: string) => void;
    },
  ) {
    super();
  }

  getState(): BridgeState {
    return this.state;
  }

  /** Open WebSocket connection to AIRI frontend. */
  connect(): void {
    if (this.disposed) return;
    if (this.state !== "disconnected") return;

    this.setState("connecting");
    const url = `ws://${this.config.host}:${this.config.port}`;
    this.logger.info(`[airi] connecting to ${url}`);

    const headers: Record<string, string> = {};
    if (this.config.token) {
      headers["authorization"] = `Bearer ${this.config.token}`;
    }

    const ws = new WebSocket(url, { headers, handshakeTimeout: 10_000 });

    ws.on("open", () => {
      this.logger.info("[airi] bridge connected");
      this.retryCount = 0;
      this.ws = ws;
      this.setState("connected");
      this.emit("connected");
    });

    ws.on("message", (raw) => {
      try {
        const parsed: unknown = JSON.parse(String(raw));
        if (isAiriInboundMessage(parsed)) {
          this.emit("message", parsed);
        } else {
          this.logger.debug?.(`[airi] ignoring unknown message type`);
        }
      } catch {
        this.logger.warn("[airi] received non-JSON message");
      }
    });

    ws.on("close", (code, reason) => {
      this.ws = null;
      const reasonStr = reason?.toString() ?? "";
      this.setState("disconnected");
      this.emit("disconnected", code, reasonStr);
      this.logger.info(`[airi] bridge disconnected (${code}: ${reasonStr})`);
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.logger.error(`[airi] bridge error: ${err.message}`);
      this.emit("error", err);
      // ws 'close' event fires after 'error', reconnect handled there
    });
  }

  /** Send a typed message to the AIRI frontend. */
  send(msg: AiriOutboundMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Gracefully close the bridge. */
  close(): void {
    this.disposed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, "plugin shutdown");
      this.ws = null;
    }
    this.setState("disconnected");
  }

  private setState(next: BridgeState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit("stateChange", next);
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    const max = this.config.reconnect?.maxRetries ?? 10;
    if (this.retryCount >= max) {
      this.logger.warn(`[airi] max reconnect retries (${max}) reached`);
      return;
    }
    const interval = this.config.reconnect?.intervalMs ?? 5000;
    this.retryCount++;
    this.logger.info(
      `[airi] reconnecting in ${interval}ms (attempt ${this.retryCount}/${max})`,
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, interval);
  }
}
