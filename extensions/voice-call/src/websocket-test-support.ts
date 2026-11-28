import { once } from "node:events";
import http from "node:http";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
// Voice Call plugin module implements websocket test support behavior.
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";

export const startUpgradeWsServer = async (params: {
  urlPath: string;
  onUpgrade: (
    request: http.IncomingMessage,
    socket: Parameters<http.Server["emit"]>[2],
    head: Buffer,
  ) => void;
}): Promise<{
  url: string;
  close: () => Promise<void>;
}> => {
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => {
    params.onUpgrade(request, socket, head);
  });

  const port = await listenOnLoopback(server);

  return {
    url: `ws://127.0.0.1:${port}${params.urlPath}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
};

export const connectWs = async (url: string): Promise<WebSocket> => {
  const ws = new WebSocket(url);
  await once(ws, "open");
  return ws;
};

export const waitForClose = async (
  ws: WebSocket,
): Promise<{
  code: number;
  reason: string;
}> => {
  const [code, reason] = (await once(ws, "close")) as [number, Buffer];
  return {
    code,
    reason: Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || ""),
  };
};
