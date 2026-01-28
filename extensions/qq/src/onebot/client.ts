/**
 * OneBot v11 WebSocket Client
 *
 * Manages WebSocket connection to NapCatQQ/OneBot server with:
 * - Connection management
 * - Heartbeat monitoring
 * - Auto-reconnection
 * - API call handling with promise-based responses
 */

import WebSocket from "ws";
import type {
  OneBotApiRequest,
  OneBotApiResponse,
  OneBotEvent,
  OneBotWsFrame,
} from "./types.js";
import { isOneBotApiResponse, isOneBotEvent } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export interface OneBotClientOptions {
  /** WebSocket URL (e.g., "ws://127.0.0.1:3001") */
  wsUrl: string;
  /** Access token for authentication */
  accessToken?: string;
  /** Reconnect interval in ms (default: 5000) */
  reconnectIntervalMs?: number;
  /** Connection timeout in ms (default: 10000) */
  connectTimeoutMs?: number;
  /** API call timeout in ms (default: 30000) */
  apiTimeoutMs?: number;
  /** Enable auto reconnect (default: true) */
  autoReconnect?: boolean;
  /** Max reconnect attempts (default: Infinity) */
  maxReconnectAttempts?: number;
}

export interface OneBotClientEvents {
  /** Called when connection is established */
  onConnect?: () => void;
  /** Called when connection is closed */
  onDisconnect?: (code: number, reason: string) => void;
  /** Called on connection error */
  onError?: (error: Error) => void;
  /** Called when an event is received */
  onEvent?: (event: OneBotEvent) => void;
  /** Called on reconnect attempt */
  onReconnect?: (attempt: number) => void;
}

interface PendingRequest {
  resolve: (response: OneBotApiResponse) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export type OneBotClientState = "disconnected" | "connecting" | "connected" | "reconnecting";

// ============================================================================
// Client Implementation
// ============================================================================

export class OneBotClient {
  private ws: WebSocket | null = null;
  private state: OneBotClientState = "disconnected";
  private options: Required<OneBotClientOptions>;
  private events: OneBotClientEvents;
  private pendingRequests = new Map<string, PendingRequest>();
  private echoCounter = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;

  constructor(options: OneBotClientOptions, events: OneBotClientEvents = {}) {
    this.options = {
      wsUrl: options.wsUrl,
      accessToken: options.accessToken ?? "",
      reconnectIntervalMs: options.reconnectIntervalMs ?? 5000,
      connectTimeoutMs: options.connectTimeoutMs ?? 10000,
      apiTimeoutMs: options.apiTimeoutMs ?? 30000,
      autoReconnect: options.autoReconnect ?? true,
      maxReconnectAttempts: options.maxReconnectAttempts ?? Infinity,
    };
    this.events = events;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Get current connection state.
   */
  getState(): OneBotClientState {
    return this.state;
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this.state === "connected" && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Connect to the OneBot server.
   */
  async connect(): Promise<void> {
    if (this.state === "connected" || this.state === "connecting") {
      return;
    }

    this.abortController = new AbortController();
    await this.doConnect();
  }

  /**
   * Disconnect from the server.
   */
  disconnect(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.clearReconnectTimer();
    this.state = "disconnected";
    this.reconnectAttempts = 0;

    if (this.ws) {
      // Reject all pending requests
      for (const [echo, pending] of this.pendingRequests) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error("Client disconnected"));
        this.pendingRequests.delete(echo);
      }

      try {
        this.ws.close(1000, "Client disconnect");
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
  }

  /**
   * Call a OneBot API action.
   */
  async callApi<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.isConnected()) {
      throw new Error("Not connected to OneBot server");
    }

    const echo = this.generateEcho();
    const request: OneBotApiRequest = { action, params, echo };

    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(echo);
        reject(new Error(`API call "${action}" timed out after ${this.options.apiTimeoutMs}ms`));
      }, this.options.apiTimeoutMs);

      this.pendingRequests.set(echo, {
        resolve: (response) => {
          if (response.status === "ok" || response.status === "async") {
            resolve(response.data as T);
          } else {
            reject(
              new Error(
                `API call "${action}" failed: ${response.message || response.wording || "Unknown error"} (retcode: ${response.retcode})`,
              ),
            );
          }
        },
        reject,
        timeoutId,
      });

      try {
        this.ws!.send(JSON.stringify(request));
      } catch (err) {
        clearTimeout(timeoutId);
        this.pendingRequests.delete(echo);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.state = "connecting";

      // Build URL with access token
      let url = this.options.wsUrl;
      if (this.options.accessToken) {
        const separator = url.includes("?") ? "&" : "?";
        url = `${url}${separator}access_token=${encodeURIComponent(this.options.accessToken)}`;
      }

      const connectTimeout = setTimeout(() => {
        if (this.state === "connecting") {
          this.ws?.close();
          this.state = "disconnected";
          const err = new Error(`Connection timeout after ${this.options.connectTimeoutMs}ms`);
          this.events.onError?.(err);
          reject(err);
        }
      }, this.options.connectTimeoutMs);

      try {
        this.ws = new WebSocket(url);

        this.ws.on("open", () => {
          clearTimeout(connectTimeout);
          this.state = "connected";
          this.reconnectAttempts = 0;
          this.events.onConnect?.();
          resolve();
        });

        this.ws.on("message", (data) => {
          this.handleMessage(data);
        });

        this.ws.on("close", (code, reason) => {
          clearTimeout(connectTimeout);
          const wasConnected = this.state === "connected";
          this.state = "disconnected";
          this.ws = null;

          // Clean up pending requests to prevent memory leak
          for (const [echo, pending] of this.pendingRequests) {
            clearTimeout(pending.timeoutId);
            pending.reject(new Error(`Connection closed (code: ${code})`));
          }
          this.pendingRequests.clear();

          this.events.onDisconnect?.(code, reason.toString());

          // Auto-reconnect if enabled and not manually disconnected
          if (
            wasConnected &&
            this.options.autoReconnect &&
            this.abortController &&
            !this.abortController.signal.aborted
          ) {
            this.scheduleReconnect();
          }
        });

        this.ws.on("error", (err) => {
          clearTimeout(connectTimeout);
          this.events.onError?.(err);
          if (this.state === "connecting") {
            this.state = "disconnected";
            reject(err);
          }
        });
      } catch (err) {
        clearTimeout(connectTimeout);
        this.state = "disconnected";
        const error = err instanceof Error ? err : new Error(String(err));
        this.events.onError?.(error);
        reject(error);
      }
    });
  }

  private handleMessage(data: WebSocket.RawData): void {
    try {
      const frame = JSON.parse(data.toString()) as OneBotWsFrame;

      if (isOneBotApiResponse(frame)) {
        // Handle API response
        const echo = frame.echo;
        if (echo && this.pendingRequests.has(echo)) {
          const pending = this.pendingRequests.get(echo)!;
          clearTimeout(pending.timeoutId);
          this.pendingRequests.delete(echo);
          pending.resolve(frame);
        }
      } else if (isOneBotEvent(frame)) {
        // Handle event
        this.events.onEvent?.(frame);
      }
    } catch {
      // Ignore parse errors
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.events.onError?.(new Error("Max reconnect attempts reached"));
      return;
    }

    this.state = "reconnecting";
    this.reconnectAttempts++;
    this.events.onReconnect?.(this.reconnectAttempts);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.abortController?.signal.aborted) return;

      try {
        await this.doConnect();
      } catch {
        // doConnect will trigger onError, and close handler will schedule next reconnect
      }
    }, this.options.reconnectIntervalMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private generateEcho(): string {
    return `moltbot_${Date.now()}_${++this.echoCounter}`;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new OneBot client instance.
 */
export function createOneBotClient(
  options: OneBotClientOptions,
  events?: OneBotClientEvents,
): OneBotClient {
  return new OneBotClient(options, events);
}
