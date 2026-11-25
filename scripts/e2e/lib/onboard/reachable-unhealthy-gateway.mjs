import { createServer, request as requestHttp } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const port = Number(process.env.OPENCLAW_ONBOARD_FIXTURE_PORT);
const backendPort = Number(process.env.OPENCLAW_ONBOARD_BACKEND_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("OPENCLAW_ONBOARD_FIXTURE_PORT must be a valid TCP port");
}
if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65535) {
  throw new Error("OPENCLAW_ONBOARD_BACKEND_PORT must be a valid TCP port");
}

const server = createServer((front, reply) => {
  const upstream = requestHttp(
    {
      hostname: "127.0.0.1",
      port: backendPort,
      method: front.method,
      path: front.url,
      headers: front.headers,
    },
    (response) => {
      reply.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(reply);
    },
  );
  upstream.on("error", () => reply.writeHead(502).end());
  front.pipe(upstream);
});
const sockets = new WebSocketServer({ server });
const peers = new Set();
let preflightSucceeded = false;

sockets.on("connection", (front) => {
  const back = new WebSocket(`ws://127.0.0.1:${backendPort}`);
  const peer = { front, back };
  const pending = [];
  let clientMode;
  const preflightIds = new Set();
  peers.add(peer);

  front.on("message", (raw) => {
    const request = JSON.parse(
      Array.isArray(raw) ? Buffer.concat(raw).toString("utf8") : Buffer.from(raw).toString("utf8"),
    );
    if (request.type === "req" && request.method === "connect") {
      clientMode = request.params?.client?.mode;
    }
    // Classic uses probe mode for reachability, then two backend health calls:
    // diagnostic preflight must succeed before the final health command fails.
    if (
      request.type === "req" &&
      request.method === "health" &&
      clientMode === "backend" &&
      preflightSucceeded
    ) {
      console.log("QA_ONBOARD_HEALTH_FAULT");
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
    if (request.type === "req" && request.method === "health" && clientMode === "backend") {
      preflightIds.add(request.id);
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
    const response = JSON.parse(raw.toString());
    if (response.type === "res" && preflightIds.delete(response.id) && response.ok === true) {
      preflightSucceeded = true;
      console.log("QA_ONBOARD_HEALTH_PREFLIGHT_OK");
    }
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
server.listen(port, "127.0.0.1", () => {
  console.log(`QA_ONBOARD_PROXY_PORT=${server.address().port}`);
});
