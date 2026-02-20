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

export function createWsConnection(opts: WsConnectionOptions) {
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let intentionalClose = false;

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
      opts.onStatusChange("connected");
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as WsMessage;
        opts.onMessage(msg);
      } catch {
        // Ignore non-JSON messages
      }
    };

    ws.onclose = () => {
      opts.onStatusChange("disconnected");
      if (!intentionalClose) {
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
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
