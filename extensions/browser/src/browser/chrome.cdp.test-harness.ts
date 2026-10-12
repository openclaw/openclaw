import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";

const CHROME_TEST_WS_MAX_PAYLOAD_BYTES = 1024 * 1024;

export async function withMockChromeCdpServer(params: {
  wsPath: string;
  onConnection?: (wss: WebSocketServer) => void;
  onCommand?: (method: string) => unknown;
  run: (baseUrl: string) => Promise<void>;
}): Promise<void> {
  const server = createServer((req, res) => {
    if (req.url === "/json/version") {
      const addr = server.address() as AddressInfo;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}${params.wsPath}`,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: CHROME_TEST_WS_MAX_PAYLOAD_BYTES });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== params.wsPath) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
  if (params.onConnection) {
    params.onConnection(wss);
  } else {
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const message = JSON.parse(rawDataToString(raw)) as {
          id?: unknown;
          method?: unknown;
        };
        if (typeof message.id === "number" && typeof message.method === "string") {
          const result = params.onCommand
            ? params.onCommand(message.method)
            : message.method === "Browser.getVersion"
              ? { product: "Chrome/Mock", userAgent: "OpenClawTest" }
              : undefined;
          if (result !== undefined) {
            ws.send(JSON.stringify({ id: message.id, result }));
          }
        }
      });
    });
  }
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  try {
    const addr = server.address() as AddressInfo;
    await params.run(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}
