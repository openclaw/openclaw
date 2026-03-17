import "./test-helpers.js";
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { installWebAutoReplyUnitTestHooks, makeSessionStore } from "./auto-reply.test-harness.js";
import { buildMentionConfig } from "./auto-reply/mentions.js";
import { createEchoTracker } from "./auto-reply/monitor/echo.js";
import { awaitBackgroundTasks } from "./auto-reply/monitor/last-route.js";
import { createWebOnMessageHandler } from "./auto-reply/monitor/on-message.js";
function makeCfg(storePath) {
  return {
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: storePath }
  };
}
function makeReplyLogger() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn()
  };
}
function createHandlerForTest(opts) {
  const backgroundTasks = /* @__PURE__ */ new Set();
  const handler = createWebOnMessageHandler({
    cfg: opts.cfg,
    verbose: false,
    connectionId: "test",
    maxMediaBytes: 1024,
    groupHistoryLimit: 3,
    groupHistories: /* @__PURE__ */ new Map(),
    groupMemberNames: /* @__PURE__ */ new Map(),
    echoTracker: createEchoTracker({ maxItems: 10 }),
    backgroundTasks,
    replyResolver: opts.replyResolver,
    replyLogger: makeReplyLogger(),
    baseMentionConfig: buildMentionConfig(opts.cfg),
    account: {}
  });
  return { handler, backgroundTasks };
}
function createLastRouteHarness(storePath) {
  const replyResolver = vi.fn().mockResolvedValue(void 0);
  const cfg = makeCfg(storePath);
  return createHandlerForTest({ cfg, replyResolver });
}
function buildInboundMessage(params) {
  return {
    id: params.id,
    from: params.from,
    conversationId: params.conversationId,
    to: params.to ?? "+2000",
    body: params.body ?? "hello",
    timestamp: params.timestamp,
    chatType: params.chatType,
    chatId: params.chatId,
    accountId: params.accountId ?? "default",
    senderE164: params.senderE164,
    senderName: params.senderName,
    selfE164: params.selfE164,
    sendComposing: vi.fn().mockResolvedValue(void 0),
    reply: vi.fn().mockResolvedValue(void 0),
    sendMedia: vi.fn().mockResolvedValue(void 0)
  };
}
async function readStoredRoutes(storePath) {
  return JSON.parse(await fs.readFile(storePath, "utf8"));
}
describe("web auto-reply last-route", () => {
  installWebAutoReplyUnitTestHooks();
  it("updates last-route for direct chats without senderE164", async () => {
    const now = Date.now();
    const mainSessionKey = "agent:main:main";
    const store = await makeSessionStore({
      [mainSessionKey]: { sessionId: "sid", updatedAt: now - 1 }
    });
    const { handler, backgroundTasks } = createLastRouteHarness(store.storePath);
    await handler(
      buildInboundMessage({
        id: "m1",
        from: "+1000",
        conversationId: "+1000",
        chatType: "direct",
        chatId: "direct:+1000",
        timestamp: now
      })
    );
    await awaitBackgroundTasks(backgroundTasks);
    const stored = await readStoredRoutes(store.storePath);
    expect(stored[mainSessionKey]?.lastChannel).toBe("whatsapp");
    expect(stored[mainSessionKey]?.lastTo).toBe("+1000");
    await store.cleanup();
  });
  it("updates last-route for group chats with account id", async () => {
    const now = Date.now();
    const groupSessionKey = "agent:main:whatsapp:group:123@g.us";
    const store = await makeSessionStore({
      [groupSessionKey]: { sessionId: "sid", updatedAt: now - 1 }
    });
    const { handler, backgroundTasks } = createLastRouteHarness(store.storePath);
    await handler(
      buildInboundMessage({
        id: "g1",
        from: "123@g.us",
        conversationId: "123@g.us",
        chatType: "group",
        chatId: "123@g.us",
        timestamp: now,
        accountId: "work",
        senderE164: "+1000",
        senderName: "Alice",
        selfE164: "+2000"
      })
    );
    await awaitBackgroundTasks(backgroundTasks);
    const stored = await readStoredRoutes(store.storePath);
    expect(stored[groupSessionKey]?.lastChannel).toBe("whatsapp");
    expect(stored[groupSessionKey]?.lastTo).toBe("123@g.us");
    expect(stored[groupSessionKey]?.lastAccountId).toBe("work");
    await store.cleanup();
  });
});
