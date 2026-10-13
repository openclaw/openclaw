import { EventEmitter } from "node:events";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startClickClackGatewayAccount } from "./gateway.js";
import { handleClickClackInbound } from "./inbound.js";
import {
  createInboundAccountConfig,
  createInboundAgentAccount,
  createInboundAuthor,
  createInboundMessage,
  createInboundRuntime,
  publishInboundAccountConfig,
} from "./inbound.test-support.js";
import { setClickClackRuntime } from "./runtime.js";
import type { ClickClackEvent, ResolvedClickClackAccount } from "./types.js";

const sockets = vi.hoisted(() => ({ websocket: vi.fn() }));
vi.mock("./http-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./http-client.js")>();
  return {
    ...actual,
    createClickClackClient: (options: Parameters<typeof actual.createClickClackClient>[0]) => ({
      ...actual.createClickClackClient(options),
      websocket: sockets.websocket,
    }),
  };
});

describe("ClickClack attachment notice admission", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const texts = {
    unavailable:
      "I could not process this attachment because it is no longer available in ClickClack. Please upload it again.",
    oversized:
      "I could not process this attachment because it exceeds this bot's media limit. Please reduce or split the file and upload it again.",
    model:
      "This ClickClack bot is configured for text-only model replies and cannot process attachments. Please send the relevant content as text.",
  };
  const cases = [
    { kind: "unavailable", outcome: "allowed" },
    { kind: "unavailable", outcome: "revoked" },
    { kind: "unavailable", outcome: "shutdown" },
    { kind: "oversized", outcome: "allowed" },
    { kind: "oversized", outcome: "revoked" },
    { kind: "model", outcome: "allowed" },
    { kind: "model", outcome: "revoked" },
  ] as const;

  it.each(cases)(
    "rechecks $kind notice admission after DM preparation ($outcome)",
    async ({ kind, outcome }) => {
      const runtime = createInboundRuntime(true);
      const account = createInboundAgentAccount({
        replyMode: kind === "model" ? "model" : "agent",
      });
      const config = createInboundAccountConfig(account);
      publishInboundAccountConfig(runtime, account);
      setClickClackRuntime(runtime);
      const abort = new AbortController();
      const stopped = new Error("notice gateway stopped");
      const preparing = createDeferred<void>();
      const prepared = createDeferred<void>();
      const notices: unknown[] = [];
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/uploads/upl_notice")
          return new Response("missing", { status: 404 });
        if (url.pathname === "/api/dms" && init?.method === "POST") {
          preparing.resolve();
          await prepared.promise;
          return Response.json({ conversation: { id: "dm_notice" } });
        }
        if (url.pathname === "/api/dms/dm_notice/messages" && init?.method === "POST") {
          notices.push(JSON.parse(String(init.body)));
          return Response.json({ message: createInboundMessage({ id: "msg_notice" }) });
        }
        throw new Error(`unexpected synthetic notice request ${url.pathname}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const operation = handleClickClackInbound({
        account,
        config,
        abortSignal: abort.signal,
        message: createInboundMessage({
          channel_id: undefined,
          direct_conversation_id: "dm_notice",
          attachments: [
            {
              id: "upl_notice",
              workspace_id: "wsp_1",
              owner_id: "usr_owner",
              filename: "notice.pdf",
              content_type: "application/pdf",
              byte_size: kind === "oversized" ? 64 * 1024 * 1024 + 1 : 3,
              width: 0,
              height: 0,
              duration_ms: 0,
              created_at: "2026-05-09T12:00:00.000Z",
            },
          ],
        }),
      });
      const sending = operation.then(
        () => ({ accepted: true }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          preparing.promise,
          sending.then(() => {
            throw new Error("notice settled before DM preparation");
          }),
        ]);
        if (outcome === "revoked")
          publishInboundAccountConfig(runtime, { ...account, allowFrom: [] });
        if (outcome === "shutdown") abort.abort(stopped);
        prepared.resolve();
        const result = await sending;
        expect(result).toEqual(
          outcome === "allowed"
            ? { accepted: true }
            : outcome === "shutdown"
              ? { error: stopped }
              : {
                  error: expect.objectContaining({
                    message: "ClickClack attachment admission is no longer current",
                  }),
                },
        );
        expect(notices).toEqual(
          outcome === "allowed" ? [{ body: texts[kind], quoted_message_id: "msg_1" }] : [],
        );
        expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
          ...(kind === "unavailable" ? ["/api/uploads/upl_notice"] : []),
          "/api/dms",
          ...(outcome === "allowed" ? ["/api/dms/dm_notice/messages"] : []),
        ]);
        expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
        expect(runtime.llm.complete).not.toHaveBeenCalled();
      } finally {
        prepared.resolve();
        await sending;
      }
    },
  );
});

class FakeSocket extends EventEmitter {
  closed = createDeferred<void>();
  close = vi.fn(() => {
    this.emit("close");
    this.closed.resolve();
  });
}

function createEvent(index: number): ClickClackEvent {
  return {
    id: `evt_${index}`,
    cursor: `cursor_${index}`,
    type: "message.created",
    workspace_id: "wsp_1",
    created_at: "2026-05-09T12:00:00.000Z",
    payload: { message_id: `msg_${index}`, author_id: "usr_owner" },
  };
}

describe("ClickClack gateway attachment outcomes", () => {
  afterEach(() => {
    sockets.websocket.mockReset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([404, 503])(
    "continues the account queue after upload HTTP %i with the correct cursor",
    async (status) => {
      vi.useFakeTimers();
      const runtime = createInboundRuntime(true);
      const account = createInboundAgentAccount({ commandMenu: false, reconnectMs: 100 });
      const config = createInboundAccountConfig(account);
      publishInboundAccountConfig(runtime, account);
      setClickClackRuntime(runtime);
      const abort = new AbortController();
      const socket = new FakeSocket();
      const socketReady = createDeferred<void>();
      const nextDispatched = createDeferred<void>();
      const replayCursors: string[] = [];
      const notices: unknown[] = [];
      let uploadRequests = 0;
      const first = createInboundMessage({
        channel_id: undefined,
        direct_conversation_id: "dm_queue",
        body: "inspect this plan",
        attachments: [
          {
            id: "upl_plan",
            workspace_id: "wsp_1",
            owner_id: "usr_owner",
            filename: "plan.png",
            content_type: "image/png",
            byte_size: 3,
            width: 100,
            height: 80,
            duration_ms: 0,
            created_at: "2026-05-09T12:00:00.000Z",
          },
        ],
      });
      const next = createInboundMessage({
        id: "msg_2",
        channel_id: undefined,
        direct_conversation_id: "dm_queue",
        body: "hello after the attachment",
      });
      const dispatch = vi.mocked(runtime.channel.inbound.dispatch);
      const originalDispatch = dispatch.getMockImplementation();
      if (!originalDispatch) throw new Error("missing inbound runtime fixture");
      dispatch.mockImplementation(async (params) => {
        const result = await originalDispatch(params);
        if (params.ctxPayload.MessageSid === "msg_2") nextDispatched.resolve();
        return result;
      });
      sockets.websocket.mockImplementation(() => {
        socketReady.resolve();
        return socket;
      });
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/me") {
          return Response.json({ user: createInboundAuthor({ id: "usr_receiver", kind: "bot" }) });
        }
        if (url.pathname === "/api/realtime/events") {
          if (url.searchParams.has("include_tail"))
            return Response.json({ events: [], tail_cursor: "cursor_0" });
          const cursor = url.searchParams.get("after_cursor") ?? "";
          replayCursors.push(cursor);
          if (cursor === "cursor_0")
            return Response.json({ events: [createEvent(1), createEvent(2)] });
          abort.abort();
          return Response.json({ events: [] });
        }
        if (url.pathname === "/api/messages/msg_1") return Response.json({ message: first });
        if (url.pathname === "/api/messages/msg_2") return Response.json({ message: next });
        if (url.pathname === "/api/uploads/upl_plan") {
          uploadRequests += 1;
          return uploadRequests === 1
            ? new Response("upload unavailable", { status })
            : new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } });
        }
        if (url.pathname === "/api/dms" && init?.method === "POST") {
          return Response.json({ conversation: { id: "dm_queue" } });
        }
        if (url.pathname === "/api/dms/dm_queue/messages" && init?.method === "POST") {
          notices.push(JSON.parse(String(init.body)));
          return Response.json({ message: createInboundMessage({ id: "msg_notice" }) });
        }
        throw new Error(`unexpected synthetic request ${init?.method ?? "GET"} ${url.pathname}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const ctx: ChannelGatewayContext<ResolvedClickClackAccount> = {
        cfg: config,
        accountId: "default",
        account,
        runtime: {
          log: vi.fn(),
          error: vi.fn(),
          exit: (code) => {
            throw new Error(`unexpected runtime exit ${code}`);
          },
        },
        abortSignal: abort.signal,
        channelRuntime: runtime.channel,
        getStatus: () => ({ accountId: "default" }),
        setStatus: vi.fn(),
        log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
      };
      const run = startClickClackGatewayAccount(ctx);
      const settled = run.then(
        () => undefined,
        (error: unknown) => {
          throw error;
        },
      );
      try {
        await Promise.race([socketReady.promise, settled]);
        socket.emit("message", Buffer.from(JSON.stringify(createEvent(1))));
        socket.emit("message", Buffer.from(JSON.stringify(createEvent(2))));
        if (status === 404) {
          await Promise.race([nextDispatched.promise, socket.closed.promise, settled]);
          expect(dispatch.mock.calls.map(([params]) => params.ctxPayload.MessageSid)).toEqual([
            "msg_2",
          ]);
          socket.close();
        } else {
          await Promise.race([socket.closed.promise, settled]);
          expect(dispatch).not.toHaveBeenCalled();
        }
        await vi.advanceTimersByTimeAsync(100);
        await settled;

        expect(dispatch.mock.calls.map(([params]) => params.ctxPayload.MessageSid)).toEqual(
          status === 404 ? ["msg_2"] : ["msg_1", "msg_2"],
        );
        expect(replayCursors).toEqual(status === 404 ? ["cursor_2"] : ["cursor_0", "cursor_2"]);
        expect(uploadRequests).toBe(status === 404 ? 1 : 2);
        expect(notices).toEqual(
          status === 404
            ? [
                {
                  body: "I could not process this attachment because it is no longer available in ClickClack. Please upload it again.",
                  quoted_message_id: "msg_1",
                },
              ]
            : [],
        );
        expect(runtime.channel.media.saveResponseMedia).toHaveBeenCalledTimes(
          status === 404 ? 0 : 1,
        );
      } finally {
        abort.abort();
        await run.catch(() => undefined);
      }
    },
  );
});
