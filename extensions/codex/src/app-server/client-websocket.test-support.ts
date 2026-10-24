import { once } from "node:events";
import { expect } from "vitest";
import { WebSocketServer } from "ws";
import type { RpcRequest } from "./protocol.js";

export async function createWebSocketPeer(
  handle: (
    request: RpcRequest,
    reply: (result: unknown) => void,
    send: (message: unknown) => void,
  ) => void,
) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const methods: string[] = [];
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const buffer = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      const request = JSON.parse(buffer.toString("utf8")) as RpcRequest;
      const send = (message: unknown) => socket.send(JSON.stringify(message));
      methods.push(request.method);
      handle(request, (result) => send({ id: request.id, result }), send);
    });
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected a loopback WebSocket port");
  }
  return {
    url: `ws://127.0.0.1:${address.port}`,
    methods,
    async close() {
      await Promise.all(
        [...server.clients].map((socket) => {
          const closed = once(socket, "close");
          socket.terminate();
          return closed;
        }),
      );
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      expect(server.clients.size).toBe(0);
      expect(server.address()).toBeNull();
    },
  };
}
