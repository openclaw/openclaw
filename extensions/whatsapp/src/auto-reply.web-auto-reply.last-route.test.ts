import "./test-helpers.js";
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import {
  installWebAutoReplyUnitTestHooks,
  makeSessionStore,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";
import { buildMentionConfig } from "./auto-reply/mentions.js";
import { createEchoTracker } from "./auto-reply/monitor/echo.js";
import { awaitBackgroundTasks } from "./auto-reply/monitor/last-route.js";
import { createWebOnMessageHandler } from "./auto-reply/monitor/on-message.js";

function makeCfg(storePath: string): OpenClawConfig {
  return {
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: storePath },
  };
}

function makeReplyLogger() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  } as unknown as Parameters<typeof createWebOnMessageHandler>[0]["replyLogger"];
}

function createHandlerForTest(opts: { cfg: OpenClawConfig; replyResolver: unknown }) {
  const backgroundTasks = new Set<Promise<unknown>>();
  const handler = createWebOnMessageHandler({
    verbose: false,
    connectionId: "test",
    maxMediaBytes: 1024,
    groupHistoryLimit: 3,
    groupHistories: new Map(),
    groupMemberNames: new Map(),
    echoTracker: createEchoTracker({ maxItems: 10 }),
    backgroundTasks,
    replyResolver: opts.replyResolver as Parameters<
      typeof createWebOnMessageHandler
    >[0]["replyResolver"],
    replyLogger: makeReplyLogger(),
    baseMentionConfig: buildMentionConfig(opts.cfg),
    account: {},
  });

  return { handler, backgroundTasks };
}

function createLastRouteHarness(storePath: string) {
  const replyResolver = vi.fn().mockResolvedValue(undefined);
  const cfg = makeCfg(storePath);
  setLoadConfigMock(cfg);
  return createHandlerForTest({ cfg, replyResolver });
}

function buildInboundMessage(params: {
  id: string;
  from: string;
  conversationId: string;
  chatType: "direct" | "group";
  chatId: string;
  timestamp: number;
  body?: string;
  to?: string;
  accountId?: string;
  senderE164?: string;
  senderName?: string;
  selfE164?: string;
}) {
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
    sendComposing: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    sendMedia: vi.fn().mockResolvedValue(undefined),
  };
}

async function readStoredRoutes(storePath: string) {
  return JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
    string,
    { lastChannel?: string; lastTo?: string; lastAccountId?: string }
  >;
}

describe("web auto-reply dynamic config", () => {
  installWebAutoReplyUnitTestHooks();

  it("picks up runtime config changes for group gating (requireMention toggle)", async () => {
    const now = Date.now();
    const groupId = "testgroup@g.us";
    const groupSessionKey = `agent:main:whatsapp:group:${groupId}`;
    const store = await makeSessionStore({
      [groupSessionKey]: { sessionId: "sid", updatedAt: now - 1 },
    });
    const replyResolver = vi.fn().mockResolvedValue(undefined);

    // Config A: group listed with requireMention: false — message passes without mention.
    const cfgA: OpenClawConfig = {
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          groups: { [groupId]: { requireMention: false } },
        },
      },
      session: { store: store.storePath },
    };
    setLoadConfigMock(cfgA);
    const { handler } = createHandlerForTest({ cfg: cfgA, replyResolver });

    await handler(
      buildInboundMessage({
        id: "g1",
        from: groupId,
        conversationId: groupId,
        chatType: "group",
        chatId: groupId,
        timestamp: now,
        senderE164: "+1000",
        senderName: "Alice",
        selfE164: "+2000",
      }),
    );
    expect(replyResolver).toHaveBeenCalledTimes(1);

    // Config B: toggle requireMention to true at runtime.
    // Because loadConfig() is called per-message (not captured at handler
    // creation), the handler sees the updated config and blocks the message.
    const cfgB: OpenClawConfig = {
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          groups: { [groupId]: { requireMention: true } },
        },
      },
      session: { store: store.storePath },
    };
    setLoadConfigMock(cfgB);

    replyResolver.mockClear();
    await handler(
      buildInboundMessage({
        id: "g2",
        from: groupId,
        conversationId: groupId,
        chatType: "group",
        chatId: groupId,
        timestamp: now + 1,
        senderE164: "+1000",
        senderName: "Alice",
        selfE164: "+2000",
      }),
    );
    // Group message without mention is now blocked by the updated config.
    expect(replyResolver).not.toHaveBeenCalled();

    await store.cleanup();
  });
});

describe("web auto-reply last-route", () => {
  installWebAutoReplyUnitTestHooks();

  it("updates last-route for direct chats without senderE164", async () => {
    const now = Date.now();
    const mainSessionKey = "agent:main:main";
    const store = await makeSessionStore({
      [mainSessionKey]: { sessionId: "sid", updatedAt: now - 1 },
    });

    const { handler, backgroundTasks } = createLastRouteHarness(store.storePath);

    await handler(
      buildInboundMessage({
        id: "m1",
        from: "+1000",
        conversationId: "+1000",
        chatType: "direct",
        chatId: "direct:+1000",
        timestamp: now,
      }),
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
      [groupSessionKey]: { sessionId: "sid", updatedAt: now - 1 },
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
        selfE164: "+2000",
      }),
    );

    await awaitBackgroundTasks(backgroundTasks);

    const stored = await readStoredRoutes(store.storePath);
    expect(stored[groupSessionKey]?.lastChannel).toBe("whatsapp");
    expect(stored[groupSessionKey]?.lastTo).toBe("123@g.us");
    expect(stored[groupSessionKey]?.lastAccountId).toBe("work");

    await store.cleanup();
  });
});
