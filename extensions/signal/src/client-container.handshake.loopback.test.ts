// Real-TCP regression from Pick-cat's handshake proof, through the public adapter.
import { once } from "node:events";
import http from "node:http";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { streamSignalEvents } from "./client-adapter.js";
import { runSignalSseLoop } from "./sse-reconnect.js";

const ACCOUNT = "+15550001111";
const BUDGET_MS = 250;

type Peer = Awaited<ReturnType<typeof createPeer>>;

async function createPeer(
  upgradeAfterMs: (attempt: number) => number | undefined,
  connected: (socket: WebSocket, attempt: number) => void = () => {},
) {
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = http.createServer((_request, response) => response.end("ok"));
  const wsServer = new WebSocketServer({ noServer: true });
  const paths: string[] = [];
  let attempts = 0;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    const attempt = ++attempts;
    paths.push(request.url ?? "");
    // Drain pending raw upgrade sockets so the peer observes the client's FIN.
    // HTTP hands ownership of these half-open sockets to the upgrade listener.
    const endPendingUpgrade = () => socket.destroy();
    socket.once("end", endPendingUpgrade);
    socket.resume();
    const waitMs = upgradeAfterMs(attempt);
    if (waitMs === undefined) {
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (socket.destroyed) {
        return;
      }
      socket.off("end", endPendingUpgrade);
      wsServer.handleUpgrade(request, socket, head, (ws) => {
        ws.on("error", () => {});
        connected(ws, attempt);
      });
    }, waitMs);
    timers.add(timer);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected a TCP listening address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    paths,
    sockets,
    get attempts() {
      return attempts;
    },
    async close() {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      const socketClosed = [...sockets].map((socket) => once(socket, "close"));
      for (const ws of wsServer.clients) {
        ws.terminate();
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await Promise.all([
        ...socketClosed,
        new Promise<void>((resolve, reject) => {
          wsServer.close((error) => (error ? reject(error) : resolve()));
        }),
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
      ]);
      expect(sockets.size).toBe(0);
    },
  };
}

describe("container adapter opening budgets with real peers", () => {
  let peer: Peer | undefined;
  let abort: AbortController | undefined;
  let stream: Promise<void> | undefined;

  afterEach(async () => {
    abort?.abort();
    try {
      await stream;
    } finally {
      await peer?.close();
      peer = undefined;
      abort = undefined;
      stream = undefined;
    }
  });

  function start(timeoutMs?: number, onEvent = vi.fn(), onStreamOpen = vi.fn()) {
    if (!peer) {
      throw new Error("peer must be listening before stream admission");
    }
    abort = new AbortController();
    stream = streamSignalEvents({
      baseUrl: peer.baseUrl,
      account: ACCOUNT,
      transportKind: "container",
      timeoutMs,
      abortSignal: abort.signal,
      onEvent,
      onStreamOpen,
    });
    // Attach immediately; afterEach still awaits and reports the original rejection.
    void stream.catch(() => {});
    return { onEvent, onStreamOpen };
  }

  it.each([
    { name: "never-upgrading", upgradeAfterMs: undefined },
    { name: "late-upgrading", upgradeAfterMs: 1_000 },
  ])("settles a $name peer within the short opening budget", async ({ upgradeAfterMs }) => {
    peer = await createPeer(() => upgradeAfterMs);
    const { onEvent, onStreamOpen } = start(BUDGET_MS);
    let watchdogFired = false;
    // The watchdog joins the baseline's otherwise 30-second opening wait on failure.
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      abort?.abort();
    }, 2_000);
    try {
      await stream;
      expect(watchdogFired).toBe(false);
      expect(onStreamOpen).not.toHaveBeenCalled();
      expect(onEvent).not.toHaveBeenCalled();
      expect(peer.paths).toEqual([`/v1/receive/${encodeURIComponent(ACCOUNT)}`]);
      await vi.waitFor(() => expect(peer?.sockets.size).toBe(0));
    } finally {
      clearTimeout(watchdog);
    }
  });

  it.each([0, undefined])(
    "keeps the default opening allowance for timeoutMs=%s",
    async (timeoutMs) => {
      peer = await createPeer(
        () => 100,
        (ws) => {
          ws.send(JSON.stringify({ envelope: { timestamp: 1 } }));
        },
      );
      const { onEvent, onStreamOpen } = start(timeoutMs);
      await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce());
      expect(onStreamOpen).toHaveBeenCalledOnce();
      expect(onEvent).toHaveBeenCalledWith({
        event: "receive",
        data: JSON.stringify({ envelope: { timestamp: 1 } }),
      });
    },
  );

  it("does not apply a positive opening budget to post-open idle or later events", async () => {
    let accepted: WebSocket | undefined;
    peer = await createPeer(
      () => 0,
      (ws) => {
        accepted = ws;
      },
    );
    const { onEvent, onStreamOpen } = start(BUDGET_MS);
    await vi.waitFor(() => expect(onStreamOpen).toHaveBeenCalledOnce());
    await delay(BUDGET_MS * 2);
    expect(accepted?.readyState).toBe(1);
    accepted?.send(JSON.stringify({ envelope: { timestamp: 2 } }));
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce());
  });

  it("aborts a pending handshake and can open the subsequent connection", async () => {
    peer = await createPeer(
      (attempt) => (attempt === 1 ? undefined : 0),
      (ws) => {
        ws.send(JSON.stringify({ envelope: { timestamp: 3 } }));
      },
    );
    const first = start(60_000);
    await vi.waitFor(() => expect(peer?.attempts).toBe(1));
    abort?.abort();
    await stream;
    expect(first.onStreamOpen).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(peer?.sockets.size).toBe(0));
    const next = start(BUDGET_MS);
    await vi.waitFor(() => expect(next.onEvent).toHaveBeenCalledOnce());
    expect(next.onStreamOpen).toHaveBeenCalledOnce();
  });

  it("reconnects after opening timeout and closure and receives subsequent events", async () => {
    peer = await createPeer(
      (attempt) => (attempt === 1 ? undefined : 0),
      (ws, attempt) => {
        ws.send(JSON.stringify({ envelope: { timestamp: attempt } }));
        if (attempt === 2) {
          ws.close();
        }
      },
    );
    abort = new AbortController();
    const events: number[] = [];
    const statusSink = vi.fn();
    stream = runSignalSseLoop({
      baseUrl: peer.baseUrl,
      account: ACCOUNT,
      transportKind: "container",
      timeoutMs: BUDGET_MS,
      abortSignal: abort.signal,
      runtime: createRuntimeSpies(),
      policy: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
      statusSink,
      onEvent: (event) => {
        const message = JSON.parse(event.data ?? "{}") as { envelope: { timestamp: number } };
        events.push(message.envelope.timestamp);
        if (events.length === 2) {
          abort?.abort();
        }
      },
    });
    void stream.catch(() => {});
    await vi.waitFor(() => expect(events).toEqual([2, 3]), { timeout: 3_000 });
    await stream;
    expect(peer.attempts).toBe(3);
    expect(statusSink).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "recovering" }));
  });

  it("permits an upgrade beyond the historical 30-second cap", async () => {
    peer = await createPeer(
      () => 31_000,
      (ws) => {
        ws.send(JSON.stringify({ envelope: { timestamp: 4 } }));
      },
    );
    const { onEvent, onStreamOpen } = start(40_000);
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce(), { timeout: 35_000 });
    expect(onStreamOpen).toHaveBeenCalledOnce();
  }, 45_000);
});
