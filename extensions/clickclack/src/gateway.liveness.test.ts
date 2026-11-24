import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { createGatewayContext } from "./gateway.test-support.js";
import type { ClickClackEvent } from "./types.js";

const mocks = vi.hoisted(() => ({
  handleClickClackInbound: vi.fn(),
  resolveClickClackInboundAccess: vi.fn(),
}));

// mock-isolation: Liveness tests observe inbound dispatch without starting agent turns.
vi.mock("./inbound.js", () => ({ handleClickClackInbound: mocks.handleClickClackInbound }));

vi.mock("./access.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./access.js")>()),
  resolveClickClackInboundAccess: mocks.resolveClickClackInboundAccess,
}));

const { startClickClackGatewayAccount } = await import("./gateway.js");

afterEach(() => vi.useRealTimers());

// A server ping/pong round trip fences real I/O after each injected clock tick.
async function roundTrip(socket: WebSocket) {
  const pong = once(socket, "pong");
  socket.ping();
  await pong;
}

it.each([true, false])(
  "checks idle realtime transport health with responsive=%s",
  async (responsive) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    const events: ClickClackEvent[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const json = (body: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/api/me") {
        return json({ user: { id: "usr_bot", handle: "bot" } });
      }
      if (url.pathname === "/api/workspaces") {
        return json({ workspaces: [{ id: "wsp_1", name: "Main", slug: "main" }] });
      }
      if (url.pathname === "/api/realtime/events") {
        if (url.searchParams.get("include_tail") === "true") {
          return json({ events: [], tail_cursor: "0" });
        }
        const after = Number(url.searchParams.get("after_cursor"));
        return json({ events: events.filter((event) => Number(event.cursor) > after) });
      }
      json({
        message: {
          id: "msg-1",
          workspace_id: "wsp_1",
          channel_id: "chn_1",
          author_id: "usr_human",
          body: "sent while the link was dead",
          body_format: "markdown",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      });
    });
    const port = await listenOnLoopback(server);
    let handshakes = 0;
    let releaseHandshake!: () => void;
    const handshakeHeld = new Promise<void>((resolve) => {
      releaseHandshake = resolve;
    });
    const wss = new WebSocketServer({
      server,
      path: "/api/realtime/ws",
      autoPong: responsive,
      verifyClient: (_info, done) => {
        handshakes++;
        void handshakeHeld.then(() => done(true));
      },
    });
    const sockets: WebSocket[] = [];
    let pings = 0;
    wss.on("connection", (socket) => {
      sockets.push(socket);
      socket.on("ping", () => {
        pings++;
      });
    });
    mocks.resolveClickClackInboundAccess.mockResolvedValue({
      shouldDispatch: true,
      commandAuthorized: true,
    });
    const abort = new AbortController();
    const ctx = createGatewayContext(abort.signal, {
      apiBaseUrl: `http://127.0.0.1:${port}`,
      reconnectMs: 5,
      commandMenu: false,
    });
    const run = startClickClackGatewayAccount(ctx);
    try {
      // One keepalive interval passes while the first handshake is still pending.
      await vi.waitFor(() => expect(handshakes).toBe(1));
      await vi.advanceTimersByTimeAsync(25_000);
      releaseHandshake();
      await vi.waitFor(() =>
        expect(ctx.setStatus).toHaveBeenCalledWith(expect.objectContaining({ connected: true })),
      );
      const socket = sockets[0]!;
      await vi.advanceTimersByTimeAsync(25_000);
      await roundTrip(socket);
      expect(pings).toBe(1);
      if (responsive) {
        for (let tick = 0; tick < 2; tick++) {
          await vi.advanceTimersByTimeAsync(25_000);
          await roundTrip(socket);
        }
        expect(pings).toBe(3);
        expect(sockets).toHaveLength(1);
        expect(ctx.setStatus).not.toHaveBeenCalledWith(
          expect.objectContaining({ lifecycle: "recovering" }),
        );
      } else {
        // The server records this event, but a dead path never delivers it live.
        events.push({
          id: "evt-1",
          cursor: "1",
          type: "message.created",
          workspace_id: "wsp_1",
          channel_id: "chn_1",
          seq: 1,
          created_at: "2026-01-01T00:00:00.000Z",
          payload: { message_id: "msg-1", author_id: "usr_human" },
        });
        await vi.advanceTimersByTimeAsync(25_000);
        await vi.waitFor(() => expect(sockets).toHaveLength(2));
        expect(ctx.log?.warn).toHaveBeenCalledWith(
          "[default] ClickClack websocket heartbeat timed out; reconnecting",
        );
        expect(ctx.setStatus).toHaveBeenCalledWith(
          expect.objectContaining({ connected: false, lifecycle: "recovering" }),
        );
        expect(mocks.handleClickClackInbound).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ message: expect.objectContaining({ id: "msg-1" }) }),
        );
      }
    } finally {
      abort.abort();
      await run;
      for (const socket of wss.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  },
);
