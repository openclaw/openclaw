import { once } from "node:events";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { WebSocket, WebSocketServer } from "ws";

type Request = { id: string; method: string; params: Record<string, unknown> };

export async function createSdkWebSocketServer() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected the SDK loopback server address");
  }
  let requestHandler: ((socket: WebSocket, request: Request) => void) | undefined;
  const sequences = new WeakMap<WebSocket, number>();
  const reply = (socket: WebSocket, id: string, payload: unknown) => {
    socket.send(JSON.stringify({ type: "res", id, ok: true, payload }));
  };
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
        reply(socket, request.id, {
          type: "hello-ok",
          protocol: 4,
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
    server,
    url: `ws://127.0.0.1:${address.port}`,
    reply,
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
    async close() {
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
