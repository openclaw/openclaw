import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  GatewayRpcClient,
  GatewayRpcError,
  resolveGatewayTargets,
  type GatewayConnectionState,
  type GatewayStreamEvent,
} from "./index.js";

export type { GatewayConnectionState, GatewayStreamEvent };

export type GatewayClientContextValue = {
  client: GatewayRpcClient | null;
  state: GatewayConnectionState;
  error: Error | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
};

const GatewayClientContext = createContext<GatewayClientContextValue | null>(null);

export type UseGatewayClientOptions = {
  gatewayBaseUrl: string;
  authToken: string | null;
  clientId?: string;
  clientVersion?: string;
};

/**
 * Manages GatewayRpcClient lifecycle and provides it via context.
 * Call connect() to establish the WebSocket connection.
 */
export function useGatewayClient(options: UseGatewayClientOptions): GatewayClientContextValue {
  const { gatewayBaseUrl, authToken } = options;
  const target = useMemo(
    () => (gatewayBaseUrl ? resolveGatewayTargets(gatewayBaseUrl) : null),
    [gatewayBaseUrl],
  );

  const [client, setClient] = useState<GatewayRpcClient | null>(null);
  const [state, setState] = useState<GatewayConnectionState>("idle");
  const [error, setError] = useState<Error | null>(null);
  const clientRef = useRef<GatewayRpcClient | null>(null);

  const connect = useCallback(async () => {
    if (!target || !authToken) {
      return;
    }
    const c = new GatewayRpcClient(target.wsUrl, authToken);
    clientRef.current = c;
    setClient(c);
    c.onStateChange((s, e) => {
      setState(s);
      setError(e);
    });
    await c.connect();
  }, [target, authToken]);

  const disconnect = useCallback(async () => {
    const c = clientRef.current;
    if (c) {
      await c.close();
      clientRef.current = null;
      setClient(null);
      setState("idle");
      setError(null);
    }
  }, []);

  useEffect(() => {
    return () => {
      void disconnect();
    };
  }, [disconnect]);

  return {
    client,
    state,
    error,
    connect,
    disconnect,
  };
}

/**
 * Hook to call a gateway RPC method and optionally refresh on relevant events.
 */
export function useGatewayRpc<T>(
  client: GatewayRpcClient | null,
  method: string,
  params: Record<string, unknown> = {},
  options?: { refreshOnEvents?: string[]; deps?: unknown[] },
): {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const deps = options?.deps ?? [];
  const refreshOnEvents = options?.refreshOnEvents ?? [];

  const refresh = useCallback(async () => {
    if (!client) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await client.request<T>(method, params);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err : new GatewayRpcError(String(err)));
    } finally {
      setLoading(false);
    }
  }, [client, method, JSON.stringify(params), ...deps]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!client || refreshOnEvents.length === 0) {
      return;
    }
    const eventSet = new Set(refreshOnEvents);
    return client.onEvent((event) => {
      if (eventSet.has(event.event)) {
        void refresh();
      }
    });
  }, [client, refresh, JSON.stringify(refreshOnEvents)]);

  return { data, error, loading, refresh };
}

/**
 * Subscribe to specific gateway event types.
 */
export function useGatewayEvents(
  client: GatewayRpcClient | null,
  filter: string | string[] | ((event: GatewayStreamEvent) => boolean),
  handler: (event: GatewayStreamEvent) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!client) {
      return;
    }
    const predicate =
      typeof filter === "function"
        ? filter
        : Array.isArray(filter)
          ? (e: GatewayStreamEvent) => filter.includes(e.event)
          : (e: GatewayStreamEvent) => e.event === filter;

    return client.onEvent((event) => {
      if (predicate(event)) {
        handlerRef.current(event);
      }
    });
  }, [client, filter]);
}

/**
 * Hook for connection status to drive UI indicators.
 */
export function useGatewayConnectionState(client: GatewayRpcClient | null): GatewayConnectionState {
  const [state, setState] = useState<GatewayConnectionState>("idle");

  useEffect(() => {
    if (!client) {
      setState("idle");
      return;
    }
    setState(client.getConnectionState());
    return client.onStateChange(setState);
  }, [client]);

  return state;
}

export type GatewayEventStreamState = {
  state: GatewayConnectionState;
  error: string | null;
  connectedAt: number | null;
  lastEventAt: number | null;
  /** Shared client for RPC calls; null until connected or when auth disabled */
  client: GatewayRpcClient | null;
};

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 15_000;
const RECONNECT_JITTER_RATIO = 0.2;

function isAuthLikeStreamError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("authentication") ||
    normalized.includes("not authorized") ||
    normalized.includes("401") ||
    normalized.includes("403")
  );
}

function normalizeStreamFailure(error: Error | null): {
  state: GatewayConnectionState;
  error: string | null;
  retryable: boolean;
} {
  if (!error) {
    return { state: "idle", error: null, retryable: false };
  }
  if (isAuthLikeStreamError(error.message)) {
    return { state: "error", error: error.message, retryable: false };
  }
  if (error instanceof GatewayRpcError) {
    if (
      error.code === "socket_error" ||
      error.code === "socket_closed" ||
      error.code === "socket_unavailable" ||
      error.code === "timeout" ||
      error.code === "closed"
    ) {
      return { state: "reconnecting", error: error.message, retryable: true };
    }
  }
  return { state: "error", error: error.message, retryable: false };
}

function computeReconnectDelay(attempt: number): number {
  const exponentialDelay = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt),
  );
  const jitterSpan = Math.round(exponentialDelay * RECONNECT_JITTER_RATIO);
  const jitter = jitterSpan > 0 ? Math.round((Math.random() * 2 - 1) * jitterSpan) : 0;
  return Math.max(RECONNECT_BASE_DELAY_MS, exponentialDelay + jitter);
}

/**
 * Manages gateway WebSocket connection with auto-reconnect and event forwarding.
 * Drop-in replacement for mission-control-ui useGatewayEventStream.
 */
export function useGatewayEventStream(params: {
  gatewayBaseUrl: string;
  authToken: string | null;
  onEvent: (event: GatewayStreamEvent) => void;
}): GatewayEventStreamState {
  const [client, setClient] = useState<GatewayRpcClient | null>(null);
  const [streamState, setStreamState] = useState<Omit<GatewayEventStreamState, "client">>({
    state: "idle",
    error: null,
    connectedAt: null,
    lastEventAt: null,
  });
  const onEventRef = useRef(params.onEvent);

  useEffect(() => {
    onEventRef.current = params.onEvent;
  }, [params.onEvent]);

  useEffect(() => {
    if (!params.authToken) {
      setClient(null);
      setStreamState({
        state: "idle",
        error: null,
        connectedAt: null,
        lastEventAt: null,
      });
      return;
    }

    const target = resolveGatewayTargets(params.gatewayBaseUrl);
    const wsClient = new GatewayRpcClient(target.wsUrl, params.authToken);
    setClient(wsClient);
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;
    let hadConnected = false;

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const connect = () => {
      if (cancelled) {
        return;
      }
      void wsClient.connect().catch(() => {});
    };

    const scheduleReconnect = (error: Error | null) => {
      if (cancelled || reconnectTimer !== null) {
        return;
      }
      const delayMs = computeReconnectDelay(reconnectAttempts);
      reconnectAttempts += 1;
      setStreamState((prev) => ({
        ...prev,
        state: "reconnecting",
        error: error?.message ?? "gateway websocket closed",
      }));
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delayMs);
    };

    const unsubscribeState = wsClient.onStateChange((state, error) => {
      if (cancelled) {
        return;
      }
      if (state === "connected") {
        hadConnected = true;
        reconnectAttempts = 0;
        clearReconnectTimer();
        setStreamState((prev) => ({
          ...prev,
          state: "connected",
          error: null,
          connectedAt: Date.now(),
        }));
        return;
      }
      if (state === "connecting") {
        setStreamState((prev) => ({
          ...prev,
          state: hadConnected || reconnectAttempts > 0 ? "reconnecting" : "connecting",
          error: prev.state === "reconnecting" ? prev.error : null,
        }));
        return;
      }
      if (state === "error") {
        const norm = normalizeStreamFailure(error);
        if (norm.retryable) {
          scheduleReconnect(error);
          return;
        }
        clearReconnectTimer();
        setStreamState((prev) => ({ ...prev, state: norm.state, error: norm.error }));
        return;
      }
      if (state === "idle" && hadConnected) {
        scheduleReconnect(error);
        return;
      }
      clearReconnectTimer();
      setStreamState((prev) => ({
        ...prev,
        state: "idle",
        error: null,
        connectedAt: null,
      }));
    });

    const unsubscribeEvents = wsClient.onEvent((event) => {
      setStreamState((prev) => ({
        ...prev,
        lastEventAt: Date.now(),
      }));
      onEventRef.current(event);
    });

    connect();

    return () => {
      cancelled = true;
      clearReconnectTimer();
      unsubscribeEvents();
      unsubscribeState();
      void wsClient.close();
      setClient(null);
    };
  }, [params.authToken, params.gatewayBaseUrl]);

  return { ...streamState, client };
}

export type GatewayClientProviderProps = {
  gatewayBaseUrl: string;
  authToken: string | null;
  children: ReactNode;
};

/**
 * Provider that creates and manages a shared GatewayRpcClient for the subtree.
 */
export function GatewayClientProvider({
  gatewayBaseUrl,
  authToken,
  children,
}: GatewayClientProviderProps): React.ReactElement {
  const value = useGatewayClient({ gatewayBaseUrl, authToken });

  return <GatewayClientContext.Provider value={value}>{children}</GatewayClientContext.Provider>;
}

/**
 * Access the gateway client from context.
 */
export function useGatewayClientContext(): GatewayClientContextValue {
  const ctx = useContext(GatewayClientContext);
  if (!ctx) {
    throw new Error("useGatewayClientContext must be used within GatewayClientProvider");
  }
  return ctx;
}
