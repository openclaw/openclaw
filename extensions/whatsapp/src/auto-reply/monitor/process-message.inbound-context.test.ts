import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { expectChannelInboundContextContract as expectInboundContextContract } from "../../../../../src/channels/plugins/contracts/suites.js";

let capturedCtx: unknown;
let capturedDispatchParams: unknown;
let sessionDir: string | undefined;
let sessionStorePath: string;
let backgroundTasks: Set<Promise<unknown>>;
const { deliverWebReplyMock } = vi.hoisted(() => ({
  deliverWebReplyMock: vi.fn(async () => {}),
}));

const defaultReplyLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeProcessMessageArgs(params: {
  msg: Record<string, unknown>;
  routeSessionKey: string;
  groupHistoryKey: string;
  cfg?: unknown;
  groupHistories?: Map<string, Array<{ sender: string; body: string }>>;
  groupHistory?: Array<{ sender: string; body: string }>;
  rememberSentText?: (text: string | undefined, opts: unknown) => void;
}) {
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    cfg: (params.cfg ?? { messages: {}, session: { store: sessionStorePath } }) as any,
    // oxlint-disable-next-line typescript/no-explicit-any
    msg: params.msg as any,
    route: {
      agentId: "main",
      accountId: "default",
      sessionKey: params.routeSessionKey,
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any,
    groupHistoryKey: params.groupHistoryKey,
    groupHistories: params.groupHistories ?? new Map(),
    groupMemberNames: new Map(),
    connectionId: "conn",
    verbose: false,
    maxMediaBytes: 1,
    // oxlint-disable-next-line typescript/no-explicit-any
    replyResolver: (async () => undefined) as any,
    // oxlint-disable-next-line typescript/no-explicit-any
    replyLogger: defaultReplyLogger as any,
    backgroundTasks,
    rememberSentText:
      params.rememberSentText ?? ((_text: string | undefined, _opts: unknown) => {}),
    echoHas: () => false,
    echoForget: () => {},
    buildCombinedEchoKey: () => "echo",
    ...(params.groupHistory ? { groupHistory: params.groupHistory } : {}),
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any;
}

function createWhatsAppDirectStreamingArgs(params?: {
  rememberSentText?: (text: string | undefined, opts: unknown) => void;
}) {
  return makeProcessMessageArgs({
    routeSessionKey: "agent:main:whatsapp:direct:+1555",
    groupHistoryKey: "+1555",
    rememberSentText: params?.rememberSentText,
    cfg: {
      channels: { whatsapp: { blockStreaming: true } },
      messages: {},
      session: { store: sessionStorePath },
    } as unknown as ReturnType<typeof import("../../../../../src/config/config.js").loadConfig>,
    msg: {
      id: "msg1",
      from: "+1555",
      to: "+2000",
      chatType: "direct",
      body: "hi",
    },
  });
}

vi.mock("../../../../../src/auto-reply/reply/provider-dispatcher.js", () => ({
  // oxlint-disable-next-line typescript/no-explicit-any
  dispatchReplyWithBufferedBlockDispatcher: vi.fn(async (params: any) => {
    capturedDispatchParams = params;
    capturedCtx = params.ctx;
    return { queuedFinal: false };
  }),
}));

vi.mock("./last-route.js", () => ({
  trackBackgroundTask: (tasks: Set<Promise<unknown>>, task: Promise<unknown>) => {
    tasks.add(task);
    void task.finally(() => {
      tasks.delete(task);
    });
  },
  updateLastRouteInBackground: vi.fn(),
}));

vi.mock("../deliver-reply.js", () => ({
  deliverWebReply: deliverWebReplyMock,
}));

import { updateLastRouteInBackground } from "./last-route.js";

let processMessage: typeof import("./process-message.js").processMessage;

describe("web processMessage inbound context", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ processMessage } = await import("./process-message.js"));
  });

  beforeEach(async () => {
    capturedCtx = undefined;
    capturedDispatchParams = undefined;
    backgroundTasks = new Set();
    deliverWebReplyMock.mockClear();
    sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-process-message-"));
    sessionStorePath = path.join(sessionDir, "sessions.json");
  });

  afterEach(async () => {
    await Promise.allSettled(Array.from(backgroundTasks));
    if (sessionDir) {
      await fs.rm(sessionDir, { recursive: true, force: true });
      sessionDir = undefined;
    }
  });

  async function processSelfDirectMessage(cfg: unknown) {
    capturedDispatchParams = undefined;
    await processMessage(
      makeProcessMessageArgs({
        routeSessionKey: "agent:main:whatsapp:direct:+1555",
        groupHistoryKey: "+1555",
        cfg,
        msg: {
          id: "msg1",
          from: "+1555",
          to: "+1555",
          selfE164: "+1555",
          chatType: "direct",
          body: "hi",
        },
      }),
    );
  }

  function getDispatcherResponsePrefix() {
    // oxlint-disable-next-line typescript/no-explicit-any
    const dispatcherOptions = (capturedDispatchParams as any)?.dispatcherOptions;
    // oxlint-disable-next-line typescript/no-explicit-any
    return dispatcherOptions?.responsePrefix as string | undefined;
  }

  it("passes a finalized MsgContext to the dispatcher", async () => {
    await processMessage(
      makeProcessMessageArgs({
        routeSessionKey: "agent:main:whatsapp:group:123",
        groupHistoryKey: "123@g.us",
        groupHistory: [],
        msg: {
          id: "msg1",
          from: "123@g.us",
          to: "+15550001111",
          chatType: "group",
          body: "hi",
          senderName: "Alice",
          senderJid: "alice@s.whatsapp.net",
          senderE164: "+15550002222",
          groupSubject: "Test Group",
          groupParticipants: [],
        },
      }),
    );

    expect(capturedCtx).toBeTruthy();
    // oxlint-disable-next-line typescript/no-explicit-any
    expectInboundContextContract(capturedCtx as any);
  });

  it("falls back SenderId to SenderE164 when senderJid is empty", async () => {
    capturedCtx = undefined;

    await processMessage(
      makeProcessMessageArgs({
        routeSessionKey: "agent:main:whatsapp:direct:+1000",
        groupHistoryKey: "+1000",
        msg: {
          id: "msg1",
          from: "+1000",
          to: "+2000",
          chatType: "direct",
          body: "hi",
          senderJid: "",
          senderE164: "+1000",
        },
      }),
    );

    expect(capturedCtx).toBeTruthy();
    // oxlint-disable-next-line typescript/no-explicit-any
    const ctx = capturedCtx as any;
    expect(ctx.SenderId).toBe("+1000");
    expect(ctx.SenderE164).toBe("+1000");
    expect(ctx.OriginatingChannel).toBe("whatsapp");
    expect(ctx.OriginatingTo).toBe("+1000");
    expect(ctx.To).toBe("+2000");
    expect(ctx.OriginatingTo).not.toBe(ctx.To);
  });

  it("defaults responsePrefix to identity name in self-chats when unset", async () => {
    await processSelfDirectMessage({
      agents: {
        list: [
          {
            id: "main",
            default: true,
            identity: { name: "Mainbot", emoji: "🦞", theme: "space lobster" },
          },
        ],
      },
      messages: {},
      session: { store: sessionStorePath },
    } as unknown as ReturnType<typeof import("../../../../../src/config/config.js").loadConfig>);

    expect(getDispatcherResponsePrefix()).toBe("[Mainbot]");
  });

  it("does not force an [openclaw] response prefix in self-chats when identity is unset", async () => {
    await processSelfDirectMessage({
      messages: {},
      session: { store: sessionStorePath },
    } as unknown as ReturnType<typeof import("../../../../../src/config/config.js").loadConfig>);

    expect(getDispatcherResponsePrefix()).toBeUndefined();
  });

  it("clears pending group history when the dispatcher does not queue a final reply", async () => {
    capturedCtx = undefined;
    const groupHistories = new Map<string, Array<{ sender: string; body: string }>>([
      [
        "whatsapp:default:group:123@g.us",
        [
          {
            sender: "Alice (+111)",
            body: "first",
          },
        ],
      ],
    ]);

    await processMessage(
      makeProcessMessageArgs({
        routeSessionKey: "agent:main:whatsapp:group:123@g.us",
        groupHistoryKey: "whatsapp:default:group:123@g.us",
        groupHistories,
        cfg: {
          messages: {},
          session: { store: sessionStorePath },
        } as unknown as ReturnType<typeof import("../../../../../src/config/config.js").loadConfig>,
        msg: {
          id: "g1",
          from: "123@g.us",
          conversationId: "123@g.us",
          to: "+2000",
          chatType: "group",
          chatId: "123@g.us",
          body: "second",
          senderName: "Bob",
          senderE164: "+222",
          selfE164: "+999",
          sendComposing: async () => {},
          reply: async () => {},
          sendMedia: async () => {},
        },
      }),
    );

    expect(groupHistories.get("whatsapp:default:group:123@g.us") ?? []).toHaveLength(0);
  });

  it("suppresses tool and block payloads when block streaming is off", async () => {
    const rememberSentText = vi.fn();
    const args = makeProcessMessageArgs({
      routeSessionKey: "agent:main:whatsapp:direct:+1555",
      groupHistoryKey: "+1555",
      rememberSentText,
      cfg: {
        channels: { whatsapp: {} },
        messages: {},
        session: { store: sessionStorePath },
      } as unknown as ReturnType<typeof import("../../../../../src/config/config.js").loadConfig>,
      msg: { id: "msg1", from: "+1555", to: "+2000", chatType: "direct", body: "hi" },
    });
    await processMessage(args);

    // oxlint-disable-next-line typescript/no-explicit-any
    const deliver = (capturedDispatchParams as any)?.dispatcherOptions?.deliver as
      | ((payload: { text?: string }, info: { kind: "tool" | "block" | "final" }) => Promise<void>)
      | undefined;
    expect(deliver).toBeTypeOf("function");

    await deliver?.({ text: "tool payload" }, { kind: "tool" });
    await deliver?.({ text: "block payload" }, { kind: "block" });
    expect(deliverWebReplyMock).not.toHaveBeenCalled();
    expect(rememberSentText).not.toHaveBeenCalled();

    await deliver?.({ text: "final payload" }, { kind: "final" });
    expect(deliverWebReplyMock).toHaveBeenCalledTimes(1);
    expect(rememberSentText).toHaveBeenCalledTimes(1);
  });

  it("delivers block payloads when block streaming is enabled", async () => {
    const rememberSentText = vi.fn();
    await processMessage(createWhatsAppDirectStreamingArgs({ rememberSentText }));

    // oxlint-disable-next-line typescript/no-explicit-any
    const deliver = (capturedDispatchParams as any)?.dispatcherOptions?.deliver as
      | ((payload: { text?: string }, info: { kind: "tool" | "block" | "final" }) => Promise<void>)
      | undefined;
    expect(deliver).toBeTypeOf("function");

    await deliver?.({ text: "tool payload" }, { kind: "tool" });
    expect(deliverWebReplyMock).not.toHaveBeenCalled();

    await deliver?.({ text: "block payload" }, { kind: "block" });
    expect(deliverWebReplyMock).toHaveBeenCalledTimes(1);

    await deliver?.({ text: "final payload" }, { kind: "final" });
    expect(deliverWebReplyMock).toHaveBeenCalledTimes(2);
  });

  it("disables block streaming when account config has blockStreaming off", async () => {
    const args = makeProcessMessageArgs({
      routeSessionKey: "agent:main:whatsapp:direct:+1555",
      groupHistoryKey: "+1555",
      cfg: {
        channels: { whatsapp: {} },
        messages: {},
        session: { store: sessionStorePath },
      } as unknown as ReturnType<typeof import("../../../../../src/config/config.js").loadConfig>,
      msg: { id: "msg1", from: "+1555", to: "+2000", chatType: "direct", body: "hi" },
    });
    await processMessage(args);

    // oxlint-disable-next-line typescript/no-explicit-any
    const replyOptions = (capturedDispatchParams as any)?.replyOptions;
    expect(replyOptions?.disableBlockStreaming).toBe(true);
  });

  it("enables block streaming when account config has blockStreaming on", async () => {
    await processMessage(createWhatsAppDirectStreamingArgs());

    // oxlint-disable-next-line typescript/no-explicit-any
    const replyOptions = (capturedDispatchParams as any)?.replyOptions;
    expect(replyOptions?.disableBlockStreaming).toBe(false);
  });

  it("passes sendComposing through as the reply typing callback", async () => {
    const sendComposing = vi.fn(async () => undefined);
    const args = createWhatsAppDirectStreamingArgs();
    args.msg = {
      ...args.msg,
      sendComposing,
    };

    await processMessage(args);

    // oxlint-disable-next-line typescript/no-explicit-any
    const dispatcherOptions = (capturedDispatchParams as any)?.dispatcherOptions;
    expect(dispatcherOptions?.onReplyStart).toBe(sendComposing);
  });

  it("updates main last route for DM when session key matches main session key", async () => {
    const updateLastRouteMock = vi.mocked(updateLastRouteInBackground);
    updateLastRouteMock.mockClear();

    const args = makeProcessMessageArgs({
      routeSessionKey: "agent:main:whatsapp:direct:+1000",
      groupHistoryKey: "+1000",
      msg: {
        id: "msg-last-route-1",
        from: "+1000",
        to: "+2000",
        chatType: "direct",
        body: "hello",
        senderE164: "+1000",
      },
    });
    args.route = {
      ...args.route,
      sessionKey: "agent:main:whatsapp:direct:+1000",
      mainSessionKey: "agent:main:whatsapp:direct:+1000",
    };

    await processMessage(args);

    expect(updateLastRouteMock).toHaveBeenCalledTimes(1);
  });

  it("does not update main last route for isolated DM scope sessions", async () => {
    const updateLastRouteMock = vi.mocked(updateLastRouteInBackground);
    updateLastRouteMock.mockClear();

    const args = makeProcessMessageArgs({
      routeSessionKey: "agent:main:whatsapp:dm:+1000:peer:+3000",
      groupHistoryKey: "+3000",
      msg: {
        id: "msg-last-route-2",
        from: "+3000",
        to: "+2000",
        chatType: "direct",
        body: "hello",
        senderE164: "+3000",
      },
    });
    args.route = {
      ...args.route,
      sessionKey: "agent:main:whatsapp:dm:+1000:peer:+3000",
      mainSessionKey: "agent:main:whatsapp:direct:+1000",
    };

    await processMessage(args);

    expect(updateLastRouteMock).not.toHaveBeenCalled();
  });

  function makePinnedMainScopeArgs(params: {
    groupHistoryKey: string;
    messageId: string;
    from: string;
  }) {
    const args = makeProcessMessageArgs({
      routeSessionKey: "agent:main:main",
      groupHistoryKey: params.groupHistoryKey,
      cfg: {
        channels: {
          whatsapp: {
            allowFrom: ["+1000"],
          },
        },
        messages: {},
        session: { store: sessionStorePath, dmScope: "main" },
      } as unknown as ReturnType<typeof import("../../../../../src/config/config.js").loadConfig>,
      msg: {
        id: params.messageId,
        from: params.from,
        to: "+2000",
        chatType: "direct",
        body: "hello",
        senderE164: params.from,
      },
    });
    args.route = {
      ...args.route,
      sessionKey: "agent:main:main",
      mainSessionKey: "agent:main:main",
    };
    return args;
  }

  it("does not update main last route for non-owner sender when main DM scope is pinned", async () => {
    const updateLastRouteMock = vi.mocked(updateLastRouteInBackground);
    updateLastRouteMock.mockClear();

    const args = makePinnedMainScopeArgs({
      groupHistoryKey: "+3000",
      messageId: "msg-last-route-3",
      from: "+3000",
    });

    await processMessage(args);

    expect(updateLastRouteMock).not.toHaveBeenCalled();
  });

  it("updates main last route for owner sender when main DM scope is pinned", async () => {
    const updateLastRouteMock = vi.mocked(updateLastRouteInBackground);
    updateLastRouteMock.mockClear();

    const args = makePinnedMainScopeArgs({
      groupHistoryKey: "+1000",
      messageId: "msg-last-route-4",
      from: "+1000",
    });

    await processMessage(args);

    expect(updateLastRouteMock).toHaveBeenCalledTimes(1);
  });
});
