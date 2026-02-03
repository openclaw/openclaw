/**
 * Gateway WebSocket Client for the Clawdbrain Web UI.
 *
 * Unified v3 protocol client with device authentication.
 *
 * Features:
 * - Protocol v3 handshake with challenge/nonce
 * - Device identity + signature authentication
 * - Standard frame shapes: { type: "req" | "res" | "event" }
 * - Automatic reconnection with exponential backoff
 * - Event subscriptions with gap detection
 */

import {
  loadDeviceAuthToken,
  storeDeviceAuthToken,
  clearDeviceAuthToken,
  buildDeviceAuthPayload,
} from "./device-auth";
import { loadOrCreateDeviceIdentity, signDevicePayload, type DeviceIdentity } from "./device-identity";

// Client constants matching the reference implementation
export const GATEWAY_CLIENT_ID = "openclaw-control-ui";
export const GATEWAY_CLIENT_MODE = "webchat";
export const DEFAULT_ROLE = "operator";
export const DEFAULT_SCOPES = ["operator.admin", "operator.approvals", "operator.pairing"];

// Frame types

export type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: { presence: number; health: number };
};

export type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
};

export type GatewayHelloOk = {
  type: "hello-ok";
  protocol: number;
  features?: { methods?: string[]; events?: string[] };
  snapshot?: unknown;
  auth?: {
    deviceToken?: string;
    role?: string;
    scopes?: string[];
    issuedAtMs?: number;
  };
  policy?: { tickIntervalMs?: number };
};

// =====================================================================
// Connection State Machine
// =====================================================================

export type GatewayConnectionState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "auth_required"; error?: string }
  | { status: "connected" }
  | { status: "error"; error: string };

export type GatewayStatus = GatewayConnectionState["status"];

export interface GatewayEvent {
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: { presence: number; health: number };
}

export interface GatewayRequestOptions {
  timeout?: number;
}

export interface GatewayAuthCredentials {
  type: "token" | "password";
  value: string;
}

export interface GatewayClientConfig {
  url?: string;
  token?: string;
  password?: string;
  clientVersion?: string;
  platform?: string;
  instanceId?: string;
  onStateChange?: (state: GatewayConnectionState) => void;
  onEvent?: (event: GatewayEvent) => void;
  onError?: (error: Error) => void;
  onHello?: (hello: GatewayHelloOk) => void;
  onGap?: (info: { expected: number; received: number }) => void;
  onClose?: (info: { code: number; reason: string }) => void;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type EventHandler = (event: GatewayEvent) => void;

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
const DEFAULT_TIMEOUT = 30000;
const MAX_BACKOFF = 15000;
const INITIAL_BACKOFF = 800;
const CONNECT_FAILED_CLOSE_CODE = 4008;
const CONNECT_TIMEOUT_MS = 750;

function getPlatform(): string {
  // Prefer modern API, fall back to deprecated navigator.platform
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("mac")) return "macos";
    if (ua.includes("win")) return "windows";
    if (ua.includes("linux")) return "linux";
    if (ua.includes("android")) return "android";
    if (ua.includes("iphone") || ua.includes("ipad")) return "ios";
  }
  return "web";
}

function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for older browsers
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    // Weak fallback
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

class GatewayClient {
  private ws: WebSocket | null = null;
  private config: GatewayClientConfig;
  private connectionState: GatewayConnectionState = { status: "disconnected" };
  private pending = new Map<string, PendingRequest>();
  private backoffMs = INITIAL_BACKOFF;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;

  // v3 protocol state
  private connectNonce: string | null = null;
  private connectSent = false;
  private lastSeq: number | null = null;
  private helloData: GatewayHelloOk | null = null;

  // State listeners for React integration
  private stateListeners = new Set<(state: GatewayConnectionState) => void>();

  // Auth state
  private authToken: string | null = null;
  private authPassword: string | null = null;

  // Subscription handlers (for direct client usage)
  private subscribers = new Map<string, Set<EventHandler>>();

  constructor(config: GatewayClientConfig = {}) {
    this.config = config;
    this.authToken = config.token ?? null;
    this.authPassword = config.password ?? null;
  }

  private setConnectionState(state: GatewayConnectionState) {
    if (
      this.connectionState.status !== state.status ||
      (state.status === "auth_required" &&
        this.connectionState.status === "auth_required" &&
        (state as { error?: string }).error !== (this.connectionState as { error?: string }).error) ||
      (state.status === "error" &&
        this.connectionState.status === "error" &&
        (state as { error: string }).error !== (this.connectionState as { error: string }).error)
    ) {
      this.connectionState = state;
      this.config.onStateChange?.(state);
      this.notifyStateChange();
    }
  }

  private notifyStateChange() {
    for (const listener of this.stateListeners) {
      try {
        listener(this.connectionState);
      } catch (err) {
        console.error("[gateway] state listener error:", err);
      }
    }
  }

  getConnectionState(): GatewayConnectionState {
    return this.connectionState;
  }

  getStatus(): GatewayStatus {
    return this.connectionState.status;
  }

  isConnected(): boolean {
    return this.connectionState.status === "connected" && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Subscribe to connection state changes.
   * Returns an unsubscribe function.
   */
  onStateChange(listener: (state: GatewayConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /**
   * Set auth credentials from the auth modal.
   * Call retryConnect() after setting credentials to attempt connection.
   */
  setAuthCredentials(credentials: GatewayAuthCredentials) {
    if (credentials.type === "token") {
      this.authToken = credentials.value;
      this.authPassword = null;
    } else {
      this.authPassword = credentials.value;
    }
  }

  /**
   * Clear stored credentials.
   */
  clearCredentials() {
    this.authToken = null;
    this.authPassword = null;
  }

  /**
   * Retry connection after setting credentials.
   */
  retryConnect(): Promise<void> {
    this.connectPromise = null;
    this.setConnectionState({ status: "connecting" });
    return this.connect();
  }

  getHelloData(): GatewayHelloOk | null {
    return this.helloData;
  }

  /**
   * Subscribe to gateway events.
   * @param event Event name to subscribe to, or "*" for all events
   * @param handler Event handler function
   * @returns Unsubscribe function
   */
  subscribe(event: string, handler: EventHandler): () => void {
    let handlers = this.subscribers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.subscribers.set(event, handlers);
    }
    handlers.add(handler);

    return () => {
      handlers?.delete(handler);
      if (handlers?.size === 0) {
        this.subscribers.delete(event);
      }
    };
  }

  connect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.stopped = false;
    this.connectPromise = new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.doConnect();
    });

    return this.connectPromise;
  }

  private doConnect() {
    if (this.stopped) {return;}

    const url = this.config.url || DEFAULT_GATEWAY_URL;
    this.setConnectionState({ status: "connecting" });
    this.connectNonce = null;
    this.connectSent = false;

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.queueConnect();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(String(event.data ?? ""));
      };

      this.ws.onclose = (ev) => {
        const reason = String(ev.reason ?? "");
        this.ws = null;
        this.clearConnectTimer();
        this.flushPending(new Error(`Connection closed (${ev.code}): ${reason}`));
        this.config.onClose?.({ code: ev.code, reason });

        // Check if this was an auth failure
        if (ev.code === CONNECT_FAILED_CLOSE_CODE || reason.includes("auth") || reason.includes("unauthorized")) {
          this.setConnectionState({
            status: "auth_required",
            error: reason || "Authentication failed",
          });
          // Don't auto-reconnect on auth failure
          this.connectPromise = null;
          this.connectReject?.(new Error(reason || "Authentication failed"));
          this.connectReject = null;
          this.connectResolve = null;
          return;
        }

        if (!this.stopped) {
          this.setConnectionState({ status: "disconnected" });
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        this.setConnectionState({ status: "error", error: "WebSocket error" });
        this.config.onError?.(new Error("WebSocket error"));
      };
    } catch (error) {
      this.setConnectionState({ status: "error", error: String(error) });
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.scheduleReconnect();
    }
  }

  private queueConnect() {
    this.connectNonce = null;
    this.connectSent = false;
    this.clearConnectTimer();
    // Wait for challenge event; fallback to direct connect after timeout
    this.connectTimer = setTimeout(() => {
      void this.sendConnect();
    }, CONNECT_TIMEOUT_MS);
  }

  private clearConnectTimer() {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private async sendConnect() {
    if (this.connectSent) {return;}
    this.connectSent = true;
    this.clearConnectTimer();

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // crypto.subtle is only available in secure contexts (HTTPS, localhost)
    const isSecureContext = typeof crypto !== "undefined" && !!crypto.subtle;

    const role = DEFAULT_ROLE;
    const scopes = DEFAULT_SCOPES;
    let deviceIdentity: DeviceIdentity | null = null;
    let canFallbackToShared = false;
    let authToken = this.authToken ?? this.config.token;

    if (isSecureContext) {
      try {
        deviceIdentity = await loadOrCreateDeviceIdentity();
        const storedToken = loadDeviceAuthToken({
          deviceId: deviceIdentity.deviceId,
          role,
        })?.token;
        if (storedToken) {
          authToken = storedToken;
          canFallbackToShared = Boolean(this.authToken ?? this.config.token);
        }
      } catch (err) {
        console.warn("[gateway] failed to load device identity:", err);
      }
    }

    const auth =
      authToken || this.authPassword || this.config.password
        ? {
            token: authToken,
            password: this.authPassword ?? this.config.password,
          }
        : undefined;

    let device:
      | {
          id: string;
          publicKey: string;
          signature: string;
          signedAt: number;
          nonce: string | undefined;
        }
      | undefined;

    if (isSecureContext && deviceIdentity) {
      const signedAtMs = Date.now();
      const nonce = this.connectNonce ?? undefined;
      const payload = buildDeviceAuthPayload({
        deviceId: deviceIdentity.deviceId,
        clientId: GATEWAY_CLIENT_ID,
        clientMode: GATEWAY_CLIENT_MODE,
        role,
        scopes,
        signedAtMs,
        token: authToken ?? null,
        nonce,
      });
      try {
        const signature = await signDevicePayload(deviceIdentity.privateKey, payload);
        device = {
          id: deviceIdentity.deviceId,
          publicKey: deviceIdentity.publicKey,
          signature,
          signedAt: signedAtMs,
          nonce,
        };
      } catch (err) {
        console.warn("[gateway] failed to sign device payload:", err);
      }
    }

    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: GATEWAY_CLIENT_ID,
        version: this.config.clientVersion ?? "dev",
        platform: this.config.platform ?? getPlatform(),
        mode: GATEWAY_CLIENT_MODE,
        instanceId: this.config.instanceId,
      },
      role,
      scopes,
      device,
      caps: [],
      auth,
      userAgent: navigator.userAgent,
      locale: navigator.language,
    };

    try {
      const hello = await this.request<GatewayHelloOk>("connect", params);

      // Store device token if provided
      if (hello?.auth?.deviceToken && deviceIdentity) {
        storeDeviceAuthToken({
          deviceId: deviceIdentity.deviceId,
          role: hello.auth.role ?? role,
          token: hello.auth.deviceToken,
          scopes: hello.auth.scopes ?? [],
        });
      }

      this.helloData = hello;
      this.backoffMs = INITIAL_BACKOFF;
      this.setConnectionState({ status: "connected" });
      this.config.onHello?.(hello);
      this.connectResolve?.();
      this.connectPromise = null;
      this.connectResolve = null;
      this.connectReject = null;
    } catch (err) {
      if (canFallbackToShared && deviceIdentity) {
        clearDeviceAuthToken({ deviceId: deviceIdentity.deviceId, role });
      }
      const error = err instanceof Error ? err : new Error(String(err));
      const errorMsg = error.message;

      // Check if this is an auth error
      if (errorMsg.includes("auth") || errorMsg.includes("unauthorized") || errorMsg.includes("token")) {
        this.setConnectionState({ status: "auth_required", error: errorMsg });
      }

      this.ws?.close(CONNECT_FAILED_CLOSE_CODE, "connect failed");
      this.config.onError?.(error);
      this.connectReject?.(error);
      this.connectPromise = null;
      this.connectResolve = null;
      this.connectReject = null;
    }
  }

  private handleMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const frame = parsed as { type?: unknown };

    // Handle event frames
    if (frame.type === "event") {
      const evt = parsed as GatewayEventFrame;

      // Handle connect.challenge event
      if (evt.event === "connect.challenge") {
        const payload = evt.payload as { nonce?: unknown } | undefined;
        const nonce = payload && typeof payload.nonce === "string" ? payload.nonce : null;
        if (nonce) {
          this.connectNonce = nonce;
          void this.sendConnect();
        }
        return;
      }

      // Track sequence for gap detection
      const seq = typeof evt.seq === "number" ? evt.seq : null;
      if (seq !== null) {
        if (this.lastSeq !== null && seq > this.lastSeq + 1) {
          this.config.onGap?.({ expected: this.lastSeq + 1, received: seq });
        }
        this.lastSeq = seq;
      }

      // Notify subscribers (for direct client usage)
      this.notifySubscribers({
        event: evt.event,
        payload: evt.payload,
        seq: evt.seq,
      });

      try {
        this.config.onEvent?.({
          event: evt.event,
          payload: evt.payload,
          seq: evt.seq,
        });
      } catch (err) {
        console.error("[gateway] event handler error:", err);
      }
      return;
    }

    // Handle response frames
    if (frame.type === "res") {
      const res = parsed as GatewayResponseFrame;
      const pending = this.pending.get(res.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(res.id);
      if (res.ok) {
        pending.resolve(res.payload);
      } else {
        pending.reject(new Error(res.error?.message ?? "Request failed"));
      }
      return;
    }
  }

  private notifySubscribers(event: GatewayEvent) {
    // Notify specific event subscribers
    const handlers = this.subscribers.get(event.event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          console.error(`[gateway] subscriber error for "${event.event}":`, err);
        }
      }
    }

    // Notify wildcard subscribers
    const wildcardHandlers = this.subscribers.get("*");
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          handler(event);
        } catch (err) {
          console.error("[gateway] wildcard subscriber error:", err);
        }
      }
    }
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) {return;}

    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 1.7, MAX_BACKOFF);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }

  private flushPending(error: Error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  stop() {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.clearConnectTimer();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.flushPending(new Error("Client stopped"));
    this.setConnectionState({ status: "disconnected" });

    if (this.connectReject) {
      this.connectReject(new Error("Client stopped"));
    }
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
    this.helloData = null;
    this.lastSeq = null;
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayRequestOptions
  ): Promise<T> {
    // Allow connect request to be sent even when not fully connected
    if (method !== "connect" && !this.isConnected()) {
      throw new Error("Not connected to gateway");
    }

    const id = generateUUID();
    const timeout = options?.timeout || DEFAULT_TIMEOUT;

    const frame = {
      type: "req",
      id,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeout);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.ws!.send(JSON.stringify(frame));
    });
  }
}

// =====================================================================
// Singleton & Factory
// =====================================================================

let gatewayClient: GatewayClient | null = null;

export function getGatewayClient(config?: GatewayClientConfig): GatewayClient {
  if (!gatewayClient) {
    gatewayClient = new GatewayClient(config);
  }
  return gatewayClient;
}

export function createGatewayClient(config?: GatewayClientConfig): GatewayClient {
  return new GatewayClient(config);
}

export function resetGatewayClient(): void {
  if (gatewayClient) {
    gatewayClient.stop();
    gatewayClient = null;
  }
}

export { GatewayClient };
