import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { listenOnLoopback } from "../../../test-support/hanging-loopback-server.js";

export async function withMockChromeCdpServer(params: {
  wsPath: string;
  advertisedPath?: string;
  browser?: string;
  version?: object;
  versionPath?: string;
  authorization?: string;
  reply?: (method: string, id: number) => unknown;
  onConnection?: (wss: WebSocketServer) => void;
  run: (
    baseUrl: string,
    requests: Array<{ authorization: string | undefined; url: string | undefined }>,
  ) => Promise<void>;
}) {
  const requests: Array<{ authorization: string | undefined; url: string | undefined }> = [];
  const server = createServer((req, res) => {
    requests.push({ authorization: req.headers.authorization, url: req.url });
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (
      pathname === (params.versionPath ?? "/json/version") &&
      (!params.authorization || req.headers.authorization === params.authorization)
    ) {
      const addr = server.address() as AddressInfo;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          params.version ?? {
            Browser: params.browser,
            webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}${params.advertisedPath ?? params.wsPath}`,
          },
        ),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== params.wsPath) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
  if (params.onConnection) {
    params.onConnection(wss);
  } else if (params.reply) {
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const request = JSON.parse(rawDataToString(data)) as { id: number; method: string };
        const result = params.reply?.(request.method, request.id);
        if (result !== undefined) {
          ws.send(JSON.stringify({ id: request.id, result }));
        }
      });
    });
  }
  const port = await listenOnLoopback(server);
  try {
    await params.run(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}
