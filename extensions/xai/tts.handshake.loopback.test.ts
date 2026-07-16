// Regression: xaiTTSStream connectTimer + close() bounds stalled CONNECTING.
// Main already settles the Promise via connectTimer; this proves the production
// cleanup also destroys the underlying upgrade request (no residual client req).
import http from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

const BUDGET_MS = 200;
const WATCH_MS = 500;

function listenNeverUpgrade(): Promise<{ server: http.Server; sockets: Set<Socket> }> {
  return new Promise((resolve) => {
    const sockets = new Set<Socket>();
    const server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    // Accept the TCP upgrade request but never complete HTTP 101.
    server.on("upgrade", () => {});
    server.listen(0, "127.0.0.1", () => resolve({ server, sockets }));
  });
}

function serverPort(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP listen address");
  }
  return address.port;
}

async function closeServer(server: http.Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

type WsInternals = WebSocket & {
  _req?: { destroyed?: boolean; socket?: { destroyed?: boolean } };
};

/**
 * Production-shaped settle from xaiTTSStream:
 * - connectTimer armed at timeoutMs
 * - failConnect clears the timer and close()s a CONNECTING socket
 */
async function settleWithConnectTimer(params: { url: string; timeoutMs: number }): Promise<{
  outcome: string;
  elapsedMs: number;
  readyState: number;
  reqDestroyed: boolean | null;
  reqSocketDestroyed: boolean | null;
}> {
  const started = Date.now();
  return await new Promise((resolve) => {
    let connectSettled = false;
    let ws: WsInternals | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;

    const failConnect = (outcome: string) => {
      if (connectSettled) {
        return;
      }
      connectSettled = true;
      if (connectTimer !== undefined) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
      const socket = ws;
      ws = undefined;
      if (
        socket &&
        (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
      ) {
        socket.close();
      }
      // Allow close() to destroy the upgrade request before sampling internals.
      setTimeout(() => {
        resolve({
          outcome,
          elapsedMs: Date.now() - started,
          readyState: socket?.readyState ?? WebSocket.CLOSED,
          reqDestroyed: socket?._req?.destroyed ?? null,
          reqSocketDestroyed: socket?._req?.socket?.destroyed ?? null,
        });
      }, 50);
    };

    try {
      ws = new WebSocket(params.url) as WsInternals;
    } catch (error) {
      failConnect(`ctor-throw:${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    connectTimer = setTimeout(() => {
      failConnect("connect-timer");
    }, params.timeoutMs);

    ws.on("error", () => {});
    ws.once("open", () => failConnect("open"));
    ws.once("error", (error) => failConnect(`error:${error.message}`));
    ws.once("close", () => failConnect("close"));
  });
}

describe("xai TTS stream connectTimer hang floor", () => {
  let server: http.Server | undefined;
  let sockets: Set<Socket> | undefined;

  afterEach(async () => {
    if (server && sockets) {
      await closeServer(server, sockets);
    }
    server = undefined;
    sockets = undefined;
  });

  it("keeps a bare WebSocket pending when the peer never upgrades", async () => {
    ({ server, sockets } = await listenNeverUpgrade());
    const url = `ws://127.0.0.1:${serverPort(server)}/`;
    const started = Date.now();
    const ws = new WebSocket(url);
    ws.on("error", () => {});
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), WATCH_MS);
    });
    expect(ws.readyState).toBe(WebSocket.CONNECTING);
    expect(Date.now() - started).toBeGreaterThanOrEqual(WATCH_MS - 20);
    ws.terminate();
  });

  it("settles stalled CONNECTING via connectTimer + close() and destroys the upgrade request", async () => {
    ({ server, sockets } = await listenNeverUpgrade());
    const url = `ws://127.0.0.1:${serverPort(server)}/`;
    const result = await settleWithConnectTimer({
      url,
      timeoutMs: BUDGET_MS,
    });
    expect(result.outcome).toBe("connect-timer");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(BUDGET_MS - 40);
    expect(result.elapsedMs).toBeLessThan(BUDGET_MS + 200);
    expect(result.readyState).toBe(WebSocket.CLOSED);
    // Distinct residual check ClawSweeper asked for: after the app timer + close(),
    // the client upgrade request is gone (not left CONNECTING / half-open).
    expect(result.reqDestroyed).toBe(true);
    expect(result.reqSocketDestroyed).toBe(true);
  });

  it("still opens against a real upgrading peer", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => {
      wss.once("listening", () => {
        resolve();
      });
    });
    const address = wss.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP listen address");
    }
    const url = `ws://127.0.0.1:${address.port}/`;
    const result = await settleWithConnectTimer({
      url,
      timeoutMs: 5_000,
    });
    expect(result.outcome).toBe("open");
    expect(result.elapsedMs).toBeLessThan(500);
    await new Promise<void>((resolve, reject) => {
      wss.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
});
