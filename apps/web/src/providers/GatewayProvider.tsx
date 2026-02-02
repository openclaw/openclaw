/**
 * Unified Gateway Provider
 *
 * Wraps the v3 gateway client in a React context for use throughout the app.
 * This replaces the legacy OpenClawProvider with the unified protocol v3 client.
 */

import * as React from "react";
import {
  getGatewayClient,
  resetGatewayClient,
  type GatewayClient,
  type GatewayConnectionState,
  type GatewayStatus,
  type GatewayEvent,
  type GatewayHelloOk,
  type GatewayClientConfig,
} from "@/lib/api";

export interface GatewayContextValue {
  /** The gateway client instance */
  client: GatewayClient;
  /** Current connection status */
  status: GatewayStatus;
  /** Whether connected */
  isConnected: boolean;
  /** Last hello-ok response */
  hello: GatewayHelloOk | null;
  /** Connect to the gateway */
  connect: () => Promise<void>;
  /** Disconnect from the gateway */
  disconnect: () => void;
  /** Add an event listener */
  addEventListener: (handler: (event: GatewayEvent) => void) => () => void;
}

const GatewayContext = React.createContext<GatewayContextValue | null>(null);

export interface GatewayProviderProps {
  children: React.ReactNode;
  /** Gateway WebSocket URL (defaults to ws://127.0.0.1:18789) */
  url?: string;
  /** Authentication token */
  token?: string;
  /** Authentication password */
  password?: string;
  /** Auto-connect on mount */
  autoConnect?: boolean;
}

export function GatewayProvider({
  children,
  url,
  token,
  password,
  autoConnect = false,
}: GatewayProviderProps) {
  const [state, setState] = React.useState<GatewayConnectionState>({ status: "disconnected" });
  const [hello, setHello] = React.useState<GatewayHelloOk | null>(null);
  const eventHandlersRef = React.useRef<Set<(event: GatewayEvent) => void>>(new Set());

  // Create client with config
  const client = React.useMemo(() => {
    const config: GatewayClientConfig = {
      url,
      token,
      password,
      onHello: setHello,
      onEvent: (event) => {
        for (const handler of eventHandlersRef.current) {
          try {
            handler(event);
          } catch (err) {
            console.error("[GatewayProvider] event handler error:", err);
          }
        }
      },
      onError: (err) => {
        console.error("[GatewayProvider] error:", err);
      },
    };
    return getGatewayClient(config);
  }, [url, token, password]);

  // Keep provider state in sync with the gateway client.
  React.useEffect(() => {
    setState(client.getConnectionState());
    return client.onStateChange(setState);
  }, [client]);

  // Auto-connect if enabled
  React.useEffect(() => {
    if (autoConnect) {
      void client.connect();
    }

    return () => {
      // Note: We don't stop the client on unmount because it's a singleton
      // that may be used by other components. The client will reconnect automatically.
    };
  }, [client, autoConnect]);

  const connect = React.useCallback(async () => {
    await client.connect();
  }, [client]);

  const disconnect = React.useCallback(() => {
    client.stop();
  }, [client]);

  const addEventListener = React.useCallback(
    (handler: (event: GatewayEvent) => void) => {
      eventHandlersRef.current.add(handler);
      return () => {
        eventHandlersRef.current.delete(handler);
      };
    },
    []
  );

  const value = React.useMemo<GatewayContextValue>(
    () => ({
      client,
      status: state.status as GatewayStatus,
      isConnected: state.status === "connected",
      hello,
      connect,
      disconnect,
      addEventListener,
    }),
    [client, state.status, hello, connect, disconnect, addEventListener]
  );

  return <GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>;
}

/**
 * Hook to access the gateway context.
 * Throws if used outside of GatewayProvider.
 */
export function useGateway(): GatewayContextValue {
  const ctx = React.useContext(GatewayContext);
  if (!ctx) {
    throw new Error("useGateway must be used within GatewayProvider");
  }
  return ctx;
}

/**
 * Hook to access the gateway context optionally.
 * Returns null if used outside of GatewayProvider.
 */
export function useOptionalGateway(): GatewayContextValue | null {
  return React.useContext(GatewayContext);
}

/**
 * Hook to access just the gateway client.
 * Returns null if not in provider or not connected.
 */
export function useGatewayClient(): GatewayClient | null {
  const ctx = React.useContext(GatewayContext);
  return ctx?.isConnected ? ctx.client : null;
}

/**
 * Hook to subscribe to gateway events.
 */
export function useGatewayEvent(handler: (event: GatewayEvent) => void) {
  const ctx = useGateway();
  const handlerRef = React.useRef(handler);

  React.useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  React.useEffect(() => {
    return ctx.addEventListener((event) => handlerRef.current(event));
  }, [ctx]);
}

/**
 * Hook to subscribe to specific gateway events by name.
 */
export function useGatewayEventByName<T = unknown>(
  eventName: string,
  handler: (payload: T) => void
) {
  const handlerRef = React.useRef(handler);

  React.useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useGatewayEvent((event) => {
    if (event.event === eventName) {
      handlerRef.current(event.payload as T);
    }
  });
}

/**
 * Reset the gateway client singleton.
 * Useful for testing or when you need a fresh connection.
 */
export { resetGatewayClient };
