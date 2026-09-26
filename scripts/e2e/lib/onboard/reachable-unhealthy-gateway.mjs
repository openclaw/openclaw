import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const port = Number(process.env.OPENCLAW_ONBOARD_FIXTURE_PORT);
const backendPort = Number(process.env.OPENCLAW_ONBOARD_BACKEND_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("OPENCLAW_ONBOARD_FIXTURE_PORT must be a valid TCP port");
}
if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65535) {
  throw new Error("OPENCLAW_ONBOARD_BACKEND_PORT must be a valid TCP port");
}

const server = createServer();
const sockets = new WebSocketServer({ server });
const peers = new Set();

sockets.on("connection", (front) => {
  const back = new WebSocket(`ws://127.0.0.1:${backendPort}`);
  const peer = { front, back };
  const pending = [];
  peers.add(peer);

  front.on("message", (raw) => {
    const request = JSON.parse(
      Array.isArray(raw) ? Buffer.concat(raw).toString("utf8") : Buffer.from(raw).toString("utf8"),
    );
    if (request.type === "req" && request.method === "health") {
      front.send(
        JSON.stringify({
          type: "res",
          id: request.id,
          ok: false,
          error: { code: "UNAVAILABLE", message: "synthetic onboarding health failure" },
        }),
      );
      return;
    }
    if (back.readyState === WebSocket.OPEN) {
      back.send(raw);
    } else {
      pending.push(raw);
    }
  });
  back.on("open", () => {
    for (const raw of pending.splice(0)) {
      back.send(raw);
    }
  });
  back.on("message", (raw) => {
    if (front.readyState === WebSocket.OPEN) {
      front.send(raw);
    }
  });
  front.on("close", () => {
    back.terminate();
    peers.delete(peer);
  });
  back.on("close", () => front.terminate());
  front.on("error", () => back.terminate());
  back.on("error", () => front.terminate());
});

const stop = () => {
  for (const peer of peers) {
    peer.front.terminate();
    peer.back.terminate();
  }
  sockets.close(() => server.close(() => process.exit(0)));
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
server.listen(port, "127.0.0.1");
