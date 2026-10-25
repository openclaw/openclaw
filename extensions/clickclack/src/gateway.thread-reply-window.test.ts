import { createServer } from "node:http";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import type { ClickClackMessage, ResolvedClickClackAccount } from "./types.js";

type GatewayContext = ChannelGatewayContext<ResolvedClickClackAccount>;

const mocks = vi.hoisted(() => ({
  handleClickClackInbound: vi.fn(),
  resolveClickClackInboundAccess: vi.fn(),
}));

// mock-isolation: Thread-window tests observe inbound dispatch without starting agent turns.
vi.mock("./inbound.js", () => ({ handleClickClackInbound: mocks.handleClickClackInbound }));

vi.mock("./access.js", () => ({
  resolveClickClackInboundAccess: mocks.resolveClickClackInboundAccess,
}));

const { startClickClackGatewayAccount } = await import("./gateway.js");

const CREATED_AT = "2026-01-01T00:00:00.000Z";
function reply(id: string, root: string, body: string, thread_seq: number): ClickClackMessage {
  return {
    id,
    body,
    thread_seq,
    workspace_id: "wsp_1",
    author_id: "usr_human",
    body_format: "markdown",
    created_at: CREATED_AT,
    thread_root_id: root,
    parent_message_id: root,
  };
}
const RESOLVABLE_MESSAGES = [
  { ...reply("msg-101", "msg_root", "reply 101", 101), channel_id: "chn_1" },
  {
    ...reply("msg_dm_reply", "msg_dm_root", "dm thread reply", 1),
    direct_conversation_id: "dmc_1",
  },
];

async function startClickClackTestServer() {
  const requestPaths: string[] = [];
  const missingMessageIds = new Set<string>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requestPaths.push(`${req.method} ${url.pathname}${url.search}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const routes: Record<string, unknown> = {
      "/api/me": { user: { id: "usr_bot", handle: "bot" } },
      "/api/workspaces": { workspaces: [{ id: "wsp_1", name: "Main", slug: "main" }] },
      "/api/realtime/events": { events: [], tail_cursor: "cursor-0" },
    };
    if (url.pathname in routes) {
      return json(200, routes[url.pathname]);
    }
    const messageMatch = url.pathname.match(/^\/api\/messages\/([^/]+)$/u);
    if (messageMatch) {
      const messageId = decodeURIComponent(messageMatch[1] ?? "");
      const message = missingMessageIds.has(messageId)
        ? undefined
        : RESOLVABLE_MESSAGES.find((candidate) => candidate.id === messageId);
      return message ? json(200, { message }) : json(404, { error: "message not found" });
    }
    json(404, { error: `unhandled ${url.pathname}` });
  });
  const port = await listenOnLoopback(server);
  const wss = new WebSocketServer({ server, path: "/api/realtime/ws" });
  const sockets = new Set<import("ws").WebSocket>();
  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return {
    apiBaseUrl: `http://127.0.0.1:${port}`,
    requestPaths,
    missingMessageIds,
    emitThreadReplyEvent: async (messageId: string, payload: Record<string, string> = {}) => {
      await vi.waitFor(() => expect(sockets.size).toBe(1));
      const frame = JSON.stringify({
        id: "evt-1",
        cursor: "cursor-1",
        type: "thread.reply_created",
        workspace_id: "wsp_1",
        channel_id: "chn_1",
        seq: 1,
        created_at: CREATED_AT,
        payload: {
          message_id: messageId,
          root_message_id: "msg_root",
          author_id: "usr_human",
          ...payload,
        },
      });
      for (const socket of sockets) {
        socket.send(frame);
      }
    },
    close: async () => {
      for (const socket of sockets) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function createGatewayContext(apiBaseUrl: string, abortSignal: AbortSignal): GatewayContext {
  return {
    cfg: {
      channels: {
        clickclack: {
          baseUrl: "https://clickclack.example",
          apiBaseUrl,
          token: "test-token",
          workspace: "main",
          reconnectMs: 5,
          commandMenu: false,
        },
      },
    } as GatewayContext["cfg"],
    accountId: "default",
    account: {} as ResolvedClickClackAccount,
    runtime: {} as GatewayContext["runtime"],
    abortSignal,
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getStatus: () => ({ accountId: "default" }) as ReturnType<GatewayContext["getStatus"]>,
    setStatus: vi.fn(),
  };
}

describe("ClickClack gateway thread reply resolution", () => {
  async function expectDispatch(id: string, body: string) {
    await vi.waitFor(() => expect(mocks.handleClickClackInbound).toHaveBeenCalledTimes(1));
    expect(mocks.handleClickClackInbound).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.objectContaining({ id, body }) }),
    );
    expect(testServer.requestPaths).toContain(`GET /api/messages/${id}`);
  }

  let testServer: Awaited<ReturnType<typeof startClickClackTestServer>>;
  let abort: AbortController;
  let run: Promise<void>;
  let ctx: GatewayContext;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.resolveClickClackInboundAccess.mockResolvedValue({
      shouldDispatch: true,
      commandAuthorized: true,
    });
    testServer = await startClickClackTestServer();
    abort = new AbortController();
    ctx = createGatewayContext(testServer.apiBaseUrl, abort.signal);
    run = startClickClackGatewayAccount(ctx);
  });

  afterEach(async () => {
    try {
      abort.abort();
      await run;
    } finally {
      await testServer.close();
    }
  });

  it("dispatches a thread reply past the server thread-reply window", async () => {
    await testServer.emitThreadReplyEvent("msg-101");
    await expectDispatch("msg-101", "reply 101");
    expect(ctx.log?.warn).not.toHaveBeenCalled();
  });

  it("dispatches a DM thread reply that never enters the root DM timeline", async () => {
    await testServer.emitThreadReplyEvent("msg_dm_reply", {
      direct_conversation_id: "dmc_1",
      root_message_id: "msg_dm_root",
    });
    await expectDispatch("msg_dm_reply", "dm thread reply");
  });

  it("records a warning instead of silently handling an unreadable event message", async () => {
    testServer.missingMessageIds.add("msg-101");

    await testServer.emitThreadReplyEvent("msg-101");
    await vi.waitFor(() =>
      expect(ctx.log?.warn).toHaveBeenCalledWith(
        expect.stringContaining("skipped unreadable ClickClack message before agent dispatch"),
      ),
    );

    expect(mocks.handleClickClackInbound).not.toHaveBeenCalled();
  });
});
