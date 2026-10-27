import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { onTestFinished } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";

export async function serve(server: Server) {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const port = await listenOnLoopback(server);
  onTestFinished(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        for (const socket of sockets) {
          socket.destroy();
        }
      }),
  );
  return `http://127.0.0.1:${port}`;
}

export function jsonServer(
  handler: (req: { url?: string | undefined }) => { statusCode?: number; body: string },
) {
  return serve(
    createServer((req, res) => {
      const response = handler({ url: req.url });
      res.writeHead(response.statusCode ?? 200, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(response.body);
    }),
  );
}
