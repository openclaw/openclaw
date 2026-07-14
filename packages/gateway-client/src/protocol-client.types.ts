export type GatewayProtocolRequestOptions = {
  timeoutMs?: number | null;
  expectFinal?: boolean;
  /**
   * Called after the request frame is handed to the local WebSocket transport.
   * This does not mean the Gateway/server accepted it.
   */
  onDispatched?: () => void;
  onAccepted?: (payload: unknown) => void;
  signal?: AbortSignal;
};
