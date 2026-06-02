import { once } from "node:events";
import http from "node:http";
import { WebSocket } from "ws";

/** Race a promise against a short test timeout and always clear the timer. */
export const withTimeout = async <T>(promise: Promise<T>, timeoutMs = 2000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

/** Starts a loopback HTTP server that delegates websocket upgrades to the caller. */
export const startUpgradeWsServer = async (params: {
  /** Path advertised in the returned websocket URL. */
  urlPath: string;
  /** Upgrade handler under test; owns accepting or rejecting the socket. */
  onUpgrade: (
    request: http.IncomingMessage,
    socket: Parameters<http.Server["emit"]>[2],
    head: Buffer,
  ) => void;
}): Promise<{
  /** Loopback websocket URL bound to the ephemeral test port. */
  url: string;
  /** Close the HTTP server and wait for the close callback. */
  close: () => Promise<void>;
}> => {
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => {
    params.onUpgrade(request, socket, head);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server address");
  }

  return {
    url: `ws://127.0.0.1:${address.port}${params.urlPath}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
};

/** Open a websocket and wait until the connection reaches the open state. */
export const connectWs = async (url: string): Promise<WebSocket> => {
  const ws = new WebSocket(url);
  await withTimeout(once(ws, "open") as Promise<[unknown]>);
  return ws;
};

/** Wait for websocket close and normalize the close reason buffer to text. */
export const waitForClose = async (
  ws: WebSocket,
): Promise<{
  code: number;
  reason: string;
}> => {
  const [code, reason] = (await withTimeout(once(ws, "close") as Promise<[number, Buffer]>)) ?? [];
  return {
    code,
    reason: Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || ""),
  };
};
