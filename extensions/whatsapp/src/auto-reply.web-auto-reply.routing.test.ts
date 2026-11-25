import "./test-helpers.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installWebAutoReplyUnitTestHooks, makeSessionStore } from "./auto-reply.test-harness.js";
import { createWebOnMessageHandler } from "./auto-reply/monitor/on-message.js";
import { createTestWebInboundMessage } from "./inbound/test-message.test-helper.js";

const updateLastRouteInBackgroundMock = vi.hoisted(() => vi.fn());
const runChannelInboundEventMock = vi.hoisted(() =>
  vi.fn(async () => ({ dispatched: false }) as never),
);

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  return {
    ...actual,
    runChannelInboundEvent: runChannelInboundEventMock,
  };
});

vi.mock("./auto-reply/monitor/last-route.js", async () => {
  const actual = await vi.importActual<typeof import("./auto-reply/monitor/last-route.js")>(
    "./auto-reply/monitor/last-route.js",
  );
  return {
    ...actual,
    updateLastRouteInBackground: (...args: unknown[]) => updateLastRouteInBackgroundMock(...args),
  };
});

describe("web auto-reply routing", () => {
  installWebAutoReplyUnitTestHooks();

  beforeEach(() => {
    updateLastRouteInBackgroundMock.mockClear();
    runChannelInboundEventMock.mockClear();
  });

  it("updates last-route for group chats with account id", async () => {
    const now = Date.now();
    const groupSessionKey = "agent:main:whatsapp:group:123@g.us";
    const store = await makeSessionStore({
      [groupSessionKey]: { sessionId: "sid", updatedAt: now - 1 },
    });

    const cfg: OpenClawConfig = {
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: store.storePath },
    };
    const backgroundTasks = new Set<Promise<unknown>>();
    const handler = createWebOnMessageHandler({
      cfg,
      verbose: false,
      connectionId: "test",
      maxMediaBytes: 1024,
      groupHistoryLimit: 3,
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      backgroundTasks,
      replyResolver: vi.fn().mockResolvedValue(undefined),
      replyLogger: {
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      } as unknown as Parameters<typeof createWebOnMessageHandler>[0]["replyLogger"],
    });

    await handler(
      createTestWebInboundMessage({
        event: { id: "g1", timestamp: now },
        payload: { body: "hello @+2000" },
        platform: {
          chatJid: "123@g.us",
          recipientJid: "+2000",
          senderE164: "+1000",
          senderName: "Alice",
          selfE164: "+2000",
        },
        admission: {
          accountId: "work",
          conversation: { kind: "group", id: "123@g.us" },
          sender: { id: "+1000" },
        },
      }),
    );

    await Promise.allSettled(backgroundTasks);
    backgroundTasks.clear();

    expect(updateLastRouteInBackgroundMock).toHaveBeenCalledTimes(1);
    const updateParams = updateLastRouteInBackgroundMock.mock.calls.at(0)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(updateParams?.cfg).toBe(cfg);
    expect(updateParams?.backgroundTasks).toBe(backgroundTasks);
    expect(updateParams?.warn).toBeTypeOf("function");
    const {
      cfg: _cfg,
      backgroundTasks: _backgroundTasks,
      warn: _warn,
      ctx,
      ...routeParams
    } = updateParams ?? {};
    expect(routeParams).toEqual({
      storeAgentId: "main",
      sessionKey: `${groupSessionKey}:thread:whatsapp-account-work`,
      to: "123@g.us",
      accountId: "work",
    });
    expect(ctx).toEqual({
      From: "123@g.us",
      To: "+2000",
      SessionKey: `${groupSessionKey}:thread:whatsapp-account-work`,
      AccountId: "work",
      ChatType: "group",
      ConversationLabel: "123@g.us",
      GroupSubject: undefined,
      SenderName: "Alice",
      SenderId: "+1000",
      SenderE164: "+1000",
      Provider: "whatsapp",
      Surface: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "123@g.us",
    });

    await store.cleanup();
  });
});
