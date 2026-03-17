import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectInboundContextContract } from "../../../../../test/helpers/inbound-contract.js";
let capturedCtx;
let capturedDispatchParams;
let sessionDir;
let sessionStorePath;
let backgroundTasks;
const { deliverWebReplyMock } = vi.hoisted(() => ({
  deliverWebReplyMock: vi.fn(async () => {
  })
}));
const defaultReplyLogger = {
  info: () => {
  },
  warn: () => {
  },
  error: () => {
  },
  debug: () => {
  }
};
function makeProcessMessageArgs(params) {
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    cfg: params.cfg ?? { messages: {}, session: { store: sessionStorePath } },
    // oxlint-disable-next-line typescript/no-explicit-any
    msg: params.msg,
    route: {
      agentId: "main",
      accountId: "default",
      sessionKey: params.routeSessionKey
      // oxlint-disable-next-line typescript/no-explicit-any
    },
    groupHistoryKey: params.groupHistoryKey,
    groupHistories: params.groupHistories ?? /* @__PURE__ */ new Map(),
    groupMemberNames: /* @__PURE__ */ new Map(),
    connectionId: "conn",
    verbose: false,
    maxMediaBytes: 1,
    // oxlint-disable-next-line typescript/no-explicit-any
    replyResolver: (async () => void 0),
    // oxlint-disable-next-line typescript/no-explicit-any
    replyLogger: defaultReplyLogger,
    backgroundTasks,
    rememberSentText: params.rememberSentText ?? ((_text, _opts) => {
    }),
    echoHas: () => false,
    echoForget: () => {
    },
    buildCombinedEchoKey: () => "echo",
    ...params.groupHistory ? { groupHistory: params.groupHistory } : {}
    // oxlint-disable-next-line typescript/no-explicit-any
  };
}
function createWhatsAppDirectStreamingArgs(params) {
  return makeProcessMessageArgs({
    routeSessionKey: "agent:main:whatsapp:direct:+1555",
    groupHistoryKey: "+1555",
    rememberSentText: params?.rememberSentText,
    cfg: {
      channels: { whatsapp: { blockStreaming: true } },
      messages: {},
      session: { store: sessionStorePath }
    },
    msg: {
      id: "msg1",
      from: "+1555",
      to: "+2000",
      chatType: "direct",
      body: "hi"
    }
  });
}
vi.mock("../../../../../src/auto-reply/reply/provider-dispatcher.js", () => ({
  // oxlint-disable-next-line typescript/no-explicit-any
  dispatchReplyWithBufferedBlockDispatcher: vi.fn(async (params) => {
    capturedDispatchParams = params;
    capturedCtx = params.ctx;
    return { queuedFinal: false };
  })
}));
vi.mock("./last-route.js", () => ({
  trackBackgroundTask: (tasks, task) => {
    tasks.add(task);
    void task.finally(() => {
      tasks.delete(task);
    });
  },
  updateLastRouteInBackground: vi.fn()
}));
vi.mock("../deliver-reply.js", () => ({
  deliverWebReply: deliverWebReplyMock
}));
import { updateLastRouteInBackground } from "./last-route.js";
import { processMessage } from "./process-message.js";
describe("web processMessage inbound contract", () => {
  beforeEach(async () => {
    capturedCtx = void 0;
    capturedDispatchParams = void 0;
    backgroundTasks = /* @__PURE__ */ new Set();
    deliverWebReplyMock.mockClear();
    sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-process-message-"));
    sessionStorePath = path.join(sessionDir, "sessions.json");
  });
  afterEach(async () => {
    await Promise.allSettled(Array.from(backgroundTasks));
    if (sessionDir) {
      await fs.rm(sessionDir, { recursive: true, force: true });
      sessionDir = void 0;
    }
  });
  async function processSelfDirectMessage(cfg) {
    capturedDispatchParams = void 0;
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
          body: "hi"
        }
      })
    );
  }
  function getDispatcherResponsePrefix() {
    const dispatcherOptions = capturedDispatchParams?.dispatcherOptions;
    return dispatcherOptions?.responsePrefix;
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
          groupParticipants: []
        }
      })
    );
    expect(capturedCtx).toBeTruthy();
    expectInboundContextContract(capturedCtx);
  });
  it("falls back SenderId to SenderE164 when senderJid is empty", async () => {
    capturedCtx = void 0;
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
          senderE164: "+1000"
        }
      })
    );
    expect(capturedCtx).toBeTruthy();
    const ctx = capturedCtx;
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
            identity: { name: "Mainbot", emoji: "\u{1F99E}", theme: "space lobster" }
          }
        ]
      },
      messages: {},
      session: { store: sessionStorePath }
    });
    expect(getDispatcherResponsePrefix()).toBe("[Mainbot]");
  });
  it("does not force an [openclaw] response prefix in self-chats when identity is unset", async () => {
    await processSelfDirectMessage({
      messages: {},
      session: { store: sessionStorePath }
    });
    expect(getDispatcherResponsePrefix()).toBeUndefined();
  });
  it("clears pending group history when the dispatcher does not queue a final reply", async () => {
    capturedCtx = void 0;
    const groupHistories = /* @__PURE__ */ new Map([
      [
        "whatsapp:default:group:123@g.us",
        [
          {
            sender: "Alice (+111)",
            body: "first"
          }
        ]
      ]
    ]);
    await processMessage(
      makeProcessMessageArgs({
        routeSessionKey: "agent:main:whatsapp:group:123@g.us",
        groupHistoryKey: "whatsapp:default:group:123@g.us",
        groupHistories,
        cfg: {
          messages: {},
          session: { store: sessionStorePath }
        },
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
          sendComposing: async () => {
          },
          reply: async () => {
          },
          sendMedia: async () => {
          }
        }
      })
    );
    expect(groupHistories.get("whatsapp:default:group:123@g.us") ?? []).toHaveLength(0);
  });
  it("suppresses non-final WhatsApp payload delivery", async () => {
    const rememberSentText = vi.fn();
    await processMessage(createWhatsAppDirectStreamingArgs({ rememberSentText }));
    const deliver = capturedDispatchParams?.dispatcherOptions?.deliver;
    expect(deliver).toBeTypeOf("function");
    await deliver?.({ text: "tool payload" }, { kind: "tool" });
    await deliver?.({ text: "block payload" }, { kind: "block" });
    expect(deliverWebReplyMock).not.toHaveBeenCalled();
    expect(rememberSentText).not.toHaveBeenCalled();
    await deliver?.({ text: "final payload" }, { kind: "final" });
    expect(deliverWebReplyMock).toHaveBeenCalledTimes(1);
    expect(rememberSentText).toHaveBeenCalledTimes(1);
  });
  it("forces disableBlockStreaming for WhatsApp dispatch", async () => {
    await processMessage(createWhatsAppDirectStreamingArgs());
    const replyOptions = capturedDispatchParams?.replyOptions;
    expect(replyOptions?.disableBlockStreaming).toBe(true);
  });
  it("passes sendComposing through as the reply typing callback", async () => {
    const sendComposing = vi.fn(async () => void 0);
    const args = createWhatsAppDirectStreamingArgs();
    args.msg = {
      ...args.msg,
      sendComposing
    };
    await processMessage(args);
    const dispatcherOptions = capturedDispatchParams?.dispatcherOptions;
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
        senderE164: "+1000"
      }
    });
    args.route = {
      ...args.route,
      sessionKey: "agent:main:whatsapp:direct:+1000",
      mainSessionKey: "agent:main:whatsapp:direct:+1000"
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
        senderE164: "+3000"
      }
    });
    args.route = {
      ...args.route,
      sessionKey: "agent:main:whatsapp:dm:+1000:peer:+3000",
      mainSessionKey: "agent:main:whatsapp:direct:+1000"
    };
    await processMessage(args);
    expect(updateLastRouteMock).not.toHaveBeenCalled();
  });
  function makePinnedMainScopeArgs(params) {
    const args = makeProcessMessageArgs({
      routeSessionKey: "agent:main:main",
      groupHistoryKey: params.groupHistoryKey,
      cfg: {
        channels: {
          whatsapp: {
            allowFrom: ["+1000"]
          }
        },
        messages: {},
        session: { store: sessionStorePath, dmScope: "main" }
      },
      msg: {
        id: params.messageId,
        from: params.from,
        to: "+2000",
        chatType: "direct",
        body: "hello",
        senderE164: params.from
      }
    });
    args.route = {
      ...args.route,
      sessionKey: "agent:main:main",
      mainSessionKey: "agent:main:main"
    };
    return args;
  }
  it("does not update main last route for non-owner sender when main DM scope is pinned", async () => {
    const updateLastRouteMock = vi.mocked(updateLastRouteInBackground);
    updateLastRouteMock.mockClear();
    const args = makePinnedMainScopeArgs({
      groupHistoryKey: "+3000",
      messageId: "msg-last-route-3",
      from: "+3000"
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
      from: "+1000"
    });
    await processMessage(args);
    expect(updateLastRouteMock).toHaveBeenCalledTimes(1);
  });
});
