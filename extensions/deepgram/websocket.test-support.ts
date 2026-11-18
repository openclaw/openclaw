import { createServer, type IncomingHttpHeaders } from "node:http";
import { afterEach } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { listenOnLoopback } from "../test-support/hanging-loopback-server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

export async function createSocketServer(onConnection: (ws: WebSocket) => void, path = "/v1") {
  const listener = createServer();
  const server = new WebSocketServer({ server: listener, maxPayload: 1024 * 1024 });
  const requests: Array<{ url: URL; headers: IncomingHttpHeaders }> = [];
  listener.on("upgrade", ({ url, headers }) =>
    requests.push({ url: new URL(url ?? "/", "http://127.0.0.1"), headers }),
  );
  server.on("connection", onConnection);
  const port = await listenOnLoopback(listener);
  cleanups.push(async () => {
    server.clients.forEach((client) => client.terminate());
    await new Promise<void>((resolve, reject) => {
      server.close(() => listener.close((error) => (error ? reject(error) : resolve())));
    });
  });
  return { baseUrl: `http://127.0.0.1:${port}${path}`, requests };
}
