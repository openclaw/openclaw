import { once } from "node:events";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { WebSocket, WebSocketServer } from "ws";

type Request = { id: string; method: string; params: Record<string, unknown> };

export async function startSdkWebSocketServer(port = 0) {
  const server = new WebSocketServer({ host: "127.0.0.1", port });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected the SDK loopback server address");
  }
  return {
    server,
    url: `ws://127.0.0.1:${address.port}`,
    async close(this: void) {
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export function replySdkRequest(socket: WebSocket, id: string, payload: unknown, ok = true) {
  socket.send(JSON.stringify({ type: "res", id, ok, ...(ok ? { payload } : { error: payload }) }));
}

export async function createSdkWebSocketServer(port = 0) {
  const { server, url, close } = await startSdkWebSocketServer(port);
  let requestHandler: ((socket: WebSocket, request: Request) => void) | undefined;
  const sequences = new WeakMap<WebSocket, number>();
  server.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "sdk-live-websocket", ts: Date.now() },
      }),
    );
    socket.on("message", (raw) => {
      const request = asRecord(JSON.parse(rawDataToString(raw)));
      if (typeof request.id !== "string" || typeof request.method !== "string") {
        throw new Error("Expected an SDK request frame");
      }
      if (request.method === "connect") {
        replySdkRequest(socket, request.id, {
          type: "hello-ok",
          protocol: PROTOCOL_VERSION,
          server: { version: "sdk-live", connId: "sdk-live-connection" },
          features: { methods: ["connect"], events: ["chat", "agent"] },
          snapshot: {
            presence: [],
            health: {},
            stateVersion: { presence: 0, health: 0 },
            uptimeMs: 1,
          },
          auth: { role: "operator", scopes: [] },
          policy: { maxPayload: 262_144, maxBufferedBytes: 262_144, tickIntervalMs: 30_000 },
        });
        return;
      }
      requestHandler?.(socket, {
        id: request.id,
        method: request.method,
        params: asRecord(request.params),
      });
    });
  });
  return {
    url,
    reply: replySdkRequest,
    setRequestHandler(handler?: typeof requestHandler) {
      requestHandler = handler;
    },
    socket() {
      const socket = [...server.clients].find(
        (candidate) => candidate.readyState === WebSocket.OPEN,
      );
      if (!socket) {
        throw new Error("Expected a live SDK WebSocket connection");
      }
      return socket;
    },
    sendEvent(socket: WebSocket, event: string, payload: unknown) {
      const seq = (sequences.get(socket) ?? 0) + 1;
      sequences.set(socket, seq);
      socket.send(JSON.stringify({ type: "event", event, payload, seq }));
    },
    close,
  };
}
