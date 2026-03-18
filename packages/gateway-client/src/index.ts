type GatewayRpcRequest = {
  type: "req";
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

type GatewayRpcResponse = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string };
};

type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
};

type GatewayHello = {
  type: "hello-ok";
  protocol: number;
  auth?: {
    scopes?: string[];
    role?: string;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type GatewayStreamEvent = {
  event: string;
  payload: unknown;
};

export type GatewayConnectionState = "idle" | "connecting" | "reconnecting" | "connected" | "error";

const REQUEST_TIMEOUT_MS = 10_000;

export class GatewayRpcError extends Error {
  readonly code: string;

  constructor(message: string, code = "gateway_error") {
    super(message);
    this.name = "GatewayRpcError";
    this.code = code;
  }
}

export class GatewayRpcClient {
  private socket: WebSocket | null = null;

  private connectPromise: Promise<void> | null = null;

  private pending = new Map<string, PendingRequest>();

  private sequence = 0;

  private connected = false;

  private eventListeners = new Set<(event: GatewayStreamEvent) => void>();

  private stateListeners = new Set<(state: GatewayConnectionState, error: Error | null) => void>();

  private state: GatewayConnectionState = "idle";

  private lastError: Error | null = null;

  private intentionalClose = false;

  constructor(
    private readonly wsUrl: string,
    private readonly authToken: string | null,
  ) {}

  getConnectionState(): GatewayConnectionState {
    return this.state;
  }

  getLastError(): Error | null {
    return this.lastError;
  }

  onEvent(listener: (event: GatewayStreamEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onStateChange(
    listener: (state: GatewayConnectionState, error: Error | null) => void,
  ): () => void {
    this.stateListeners.add(listener);
    listener(this.state, this.lastError);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  async connect(): Promise<void> {
    await this.ensureConnected();
  }

  async request<TPayload>(method: string, params: Record<string, unknown> = {}): Promise<TPayload> {
    await this.ensureConnected();
    return this.requestRaw<TPayload>(method, params);
  }

  async close(): Promise<void> {
    this.intentionalClose = true;
    this.connected = false;
    this.connectPromise = null;
    if (!this.socket) {
      this.setState("idle", null);
      return;
    }
    this.socket.close();
    this.socket = null;
    for (const pending of this.pending.values()) {
      pending.reject(new GatewayRpcError("connection closed", "closed"));
    }
    this.pending.clear();
    this.setState("idle", null);
  }

  private setState(state: GatewayConnectionState, error: Error | null): void {
    this.state = state;
    this.lastError = error;
    for (const listener of this.stateListeners) {
      listener(state, error);
    }
  }

  private getConnectClientInfo(): { userAgent: string; locale: string } {
    if (typeof navigator !== "undefined") {
      return {
        userAgent: navigator.userAgent,
        locale: navigator.language,
      };
    }
    return { userAgent: "unknown", locale: "en" };
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected && this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.setState("connecting", null);
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.socket = ws;
      this.intentionalClose = false;
      let connectTimer: ReturnType<typeof setTimeout> | null = null;
      let connectRequested = false;

      const clearConnectTimer = () => {
        if (connectTimer !== null) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
      };

      const { userAgent, locale } = this.getConnectClientInfo();

      const sendConnect = () => {
        if (connectRequested) {
          return;
        }
        connectRequested = true;
        clearConnectTimer();

        void this.requestRaw<GatewayHello>("connect", {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: "openclaw-cavi-control-ui",
            version: "0.2.0",
            platform: "web",
            mode: "webchat",
          },
          role: "operator",
          scopes: ["operator.read"],
          caps: [],
          auth: this.authToken
            ? {
                token: this.authToken,
                password: this.authToken,
              }
            : undefined,
          userAgent,
          locale,
        })
          .then(() => {
            this.connected = true;
            this.setState("connected", null);
            resolve();
          })
          .catch((error) => {
            const normalizedError =
              error instanceof Error
                ? error
                : new GatewayRpcError("gateway connect failed", "connect_failed");
            this.setState("error", normalizedError);
            ws.close();
            reject(normalizedError);
          });
      };

      const onOpen = () => {
        connectTimer = setTimeout(() => {
          sendConnect();
        }, 750);
      };

      const onMessage = (event: MessageEvent) => {
        if (typeof event.data === "string") {
          try {
            const parsed = JSON.parse(event.data) as {
              type?: unknown;
              event?: unknown;
            };
            if (parsed.type === "event" && parsed.event === "connect.challenge") {
              sendConnect();
              return;
            }
          } catch {
            // Let the regular frame handler ignore invalid payloads.
          }
        }
        this.handleMessage(event);
      };

      const onError = () => {
        clearConnectTimer();
        const error = new GatewayRpcError("gateway websocket failed", "socket_error");
        this.setState("error", error);
        reject(error);
      };

      const onClose = () => {
        clearConnectTimer();
        this.connected = false;
        this.connectPromise = null;
        for (const pending of this.pending.values()) {
          pending.reject(new GatewayRpcError("gateway websocket closed", "socket_closed"));
        }
        this.pending.clear();
        if (this.intentionalClose) {
          this.intentionalClose = false;
          this.setState("idle", null);
          return;
        }
        this.setState("error", new GatewayRpcError("gateway websocket closed", "socket_closed"));
      };

      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("message", onMessage);
      ws.addEventListener("error", onError, { once: true });
      ws.addEventListener("close", onClose);
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  private async requestRaw<TPayload>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<TPayload> {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new GatewayRpcError("gateway websocket is not connected", "socket_unavailable");
    }

    const id = `mc-${Date.now()}-${this.sequence++}`;
    const frame: GatewayRpcRequest = {
      type: "req",
      id,
      method,
      params,
    };

    return await new Promise<TPayload>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayRpcError(`request timed out: ${method}`, "timeout"));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as TPayload);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      ws.send(JSON.stringify(frame));
    });
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      return;
    }

    const eventFrame = parsed as Partial<GatewayEventFrame>;
    if (eventFrame.type === "event" && typeof eventFrame.event === "string") {
      const streamEvent: GatewayStreamEvent = {
        event: eventFrame.event,
        payload: eventFrame.payload,
      };
      for (const listener of this.eventListeners) {
        listener(streamEvent);
      }
      return;
    }

    const frame = parsed as Partial<GatewayRpcResponse>;
    if (frame.type !== "res" || typeof frame.id !== "string") {
      return;
    }

    const pending = this.pending.get(frame.id);
    if (!pending) {
      return;
    }
    this.pending.delete(frame.id);

    if (!frame.ok) {
      const message = frame.error?.message ?? "gateway request failed";
      pending.reject(new GatewayRpcError(message, frame.error?.code ?? "request_failed"));
      return;
    }

    pending.resolve(frame.payload);
  }
}

export function resolveGatewayTargets(baseHttpUrl: string): {
  httpBase: string;
  wsUrl: string;
} {
  const normalizedHttp = baseHttpUrl.replace(/\/$/, "");
  const url = new URL(normalizedHttp);
  const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${wsProtocol}//${url.host}/ws`;
  return {
    httpBase: normalizedHttp,
    wsUrl,
  };
}
