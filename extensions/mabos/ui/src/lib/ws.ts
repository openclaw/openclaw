export type WsStatus = "connecting" | "connected" | "disconnected";

export type WsMessage = {
  type: string;
  [key: string]: unknown;
};

export type WsConnectionOptions = {
  url: string;
  onMessage: (msg: WsMessage) => void;
  onStatusChange: (status: WsStatus) => void;
};

const MIN_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30_000;

export function createWsConnection(opts: WsConnectionOptions) {
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let intentionalClose = false;
  let reconnectDelay = MIN_RECONNECT_MS;

  function connect() {
    intentionalClose = false;
    opts.onStatusChange("connecting");

    try {
      ws = new WebSocket(opts.url);
    } catch {
      opts.onStatusChange("disconnected");
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      reconnectDelay = MIN_RECONNECT_MS;
      opts.onStatusChange("connected");
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as WsMessage;
        opts.onMessage(msg);
      } catch (err) {
        console.warn("[ws] Failed to parse message:", err);
      }
    };

    ws.onclose = () => {
      opts.onStatusChange("disconnected");
      if (!intentionalClose) {
        scheduleReconnect();
      }
    };

    ws.onerror = (event) => {
      console.warn("[ws] Connection error:", event);
      ws?.close();
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, reconnectDelay);
    // Exponential backoff: 1s → 2s → 4s → 8s → ... → 30s max
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
  }

  function send(msg: WsMessage) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  function disconnect() {
    intentionalClose = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
    ws = null;
  }

  connect();

  return { send, disconnect };
}
