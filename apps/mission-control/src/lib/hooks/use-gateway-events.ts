"use client";

import { useEffect } from "react";

export type GatewayConnectionState =
  | "connecting"
  | "connected"
  | "disconnected";

export interface GatewayEvent {
  type: "status" | "gateway_event" | "ping";
  event?: string;
  payload?: unknown;
  seq?: number;
  ts: string;
}

type EventListener = (event: GatewayEvent) => void;
type StateListener = (state: GatewayConnectionState) => void;

class GatewayEventBus {
  private eventSource: EventSource | null = null;
  private eventListeners = new Set<EventListener>();
  private stateListeners = new Set<StateListener>();
  private state: GatewayConnectionState = "disconnected";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt = 0;

  private readonly STALE_TIMEOUT_MS = 45_000;
  private readonly STALE_CHECK_INTERVAL_MS = 5_000;

  private notifyState(state: GatewayConnectionState): void {
    if (this.state === state) {return;}
    this.state = state;
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // Ignore subscriber errors.
      }
    }
  }

  private hasSubscribers(): boolean {
    return this.eventListeners.size > 0 || this.stateListeners.size > 0;
  }

  private markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {return;}
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private startStaleWatch(): void {
    if (this.staleTimer || typeof window === "undefined") {return;}

    this.staleTimer = setInterval(() => {
      if (!this.eventSource) {return;}
      const staleForMs = Date.now() - this.lastActivityAt;
      if (staleForMs <= this.STALE_TIMEOUT_MS) {return;}

      // If heartbeats stop, recycle the stream to force a fresh connection.
      this.eventSource.close();
      this.eventSource = null;
      this.scheduleReconnect();
    }, this.STALE_CHECK_INTERVAL_MS);
  }

  private stopStaleWatch(): void {
    if (!this.staleTimer) {return;}
    clearInterval(this.staleTimer);
    this.staleTimer = null;
  }

  private scheduleReconnect(): void {
    if (!this.hasSubscribers()) {
      this.notifyState("disconnected");
      return;
    }
    if (this.reconnectTimer) {return;}

    const baseDelay = Math.min(1000 * 2 ** this.reconnectAttempts, 15_000);
    const jitter = Math.floor(Math.random() * 400);
    const delayMs = baseDelay + jitter;
    this.reconnectAttempts++;
    this.notifyState("connecting");

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private connect(): void {
    if (typeof window === "undefined") {return;}
    if (!this.hasSubscribers()) {return;}
    if (this.eventSource) {return;}

    this.clearReconnectTimer();
    this.notifyState("connecting");

    // Auth cookie (mc_api_auth) is sent automatically by the browser.
    // withCredentials ensures cookies are included for same-origin SSE.
    const source = new EventSource("/api/openclaw/events", { withCredentials: true });
    this.eventSource = source;
    this.markActivity();
    this.startStaleWatch();

    source.onopen = () => {
      this.reconnectAttempts = 0;
      this.markActivity();
      this.notifyState("connected");
    };

    source.onmessage = (message) => {
      try {
        this.markActivity();
        const parsed = JSON.parse(message.data) as GatewayEvent;
        for (const listener of this.eventListeners) {
          listener(parsed);
        }
      } catch {
        // Ignore malformed events.
      }
    };

    source.onerror = () => {
      if (this.eventSource !== source) {return;}
      source.close();
      this.eventSource = null;
      this.scheduleReconnect();
    };
  }

  private disconnectIfIdle(): void {
    if (this.hasSubscribers()) {return;}
    this.clearReconnectTimer();
    this.stopStaleWatch();
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.reconnectAttempts = 0;
    this.notifyState("disconnected");
  }

  subscribe(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    this.connect();
    return () => {
      this.eventListeners.delete(listener);
      this.disconnectIfIdle();
    };
  }

  subscribeState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    this.connect();
    return () => {
      this.stateListeners.delete(listener);
      this.disconnectIfIdle();
    };
  }
}

const gatewayEventBus = new GatewayEventBus();

export function useGatewayEvents(
  onEvent: (event: GatewayEvent) => void
): void {
  useEffect(() => {
    return gatewayEventBus.subscribe(onEvent);
  }, [onEvent]);
}

export function useGatewayConnectionState(
  onStateChange: (state: GatewayConnectionState) => void
): void {
  useEffect(() => {
    return gatewayEventBus.subscribeState(onStateChange);
  }, [onStateChange]);
}
