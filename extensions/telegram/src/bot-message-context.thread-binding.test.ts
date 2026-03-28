import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const recordInboundSessionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const resolveTelegramConversationRouteMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    recordInboundSession: (...args: unknown[]) => recordInboundSessionMock(...args),
  };
});
vi.mock("./conversation-route.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./conversation-route.js")>();
  return {
    ...actual,
    resolveTelegramConversationRoute: (...args: unknown[]) =>
      resolveTelegramConversationRouteMock(...args),
  };
});

let buildTelegramMessageContextForTest: typeof import("./bot-message-context.test-harness.js").buildTelegramMessageContextForTest;

function createBoundRoute(params: {
  accountId: string;
  sessionKey: string;
  agentId: string;
}) {
  return {
    configuredBinding: null,
    configuredBindingSessionKey: "",
    route: {
      accountId: params.accountId,
      agentId: params.agentId,
      channel: "telegram",
      sessionKey: params.sessionKey,
      mainSessionKey: `agent:${params.agentId}:main`,
      matchedBy: "binding.channel",
      lastRoutePolicy: "bound",
    },
  } as const;
}

describe("buildTelegramMessageContext thread binding override", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ buildTelegramMessageContextForTest } =
      await import("./bot-message-context.test-harness.js"));
  });

  beforeEach(() => {
    recordInboundSessionMock.mockClear();
    resolveTelegramConversationRouteMock.mockReset();
  });

  it("passes forum topic messages through the route seam and uses the bound session", async () => {
    resolveTelegramConversationRouteMock.mockReturnValue(
      createBoundRoute({
        accountId: "default",
        sessionKey: "agent:codex-acp:session-1",
        agentId: "codex-acp",
      }),
    );

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 1,
        chat: { id: -100200300, type: "supergroup", is_forum: true },
        message_thread_id: 77,
        date: 1_700_000_000,
        text: "hello",
        from: { id: 42, first_name: "Alice" },
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

    expect(resolveTelegramConversationRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        chatId: -100200300,
        isGroup: true,
        resolvedThreadId: 77,
        replyThreadId: 77,
        senderId: "42",
      }),
    );
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:codex-acp:session-1");
    expect(recordInboundSessionMock.mock.calls[0]?.[0]).toMatchObject({
      updateLastRoute: undefined,
    });
  });

  it("treats named-account bound conversations as explicit route matches", async () => {
    resolveTelegramConversationRouteMock.mockReturnValue(
      createBoundRoute({
        accountId: "work",
        sessionKey: "agent:codex-acp:session-2",
        agentId: "codex-acp",
      }),
    );

    const ctx = await buildTelegramMessageContextForTest({
      accountId: "work",
      message: {
        message_id: 1,
        chat: { id: -100200300, type: "supergroup", is_forum: true },
        message_thread_id: 77,
        date: 1_700_000_000,
        text: "hello",
        from: { id: 42, first_name: "Alice" },
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

    expect(resolveTelegramConversationRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "work",
        chatId: -100200300,
        isGroup: true,
        resolvedThreadId: 77,
        replyThreadId: 77,
        senderId: "42",
      }),
    );
    expect(ctx).not.toBeNull();
    expect(ctx?.route.accountId).toBe("work");
    expect(ctx?.route.matchedBy).toBe("binding.channel");
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:codex-acp:session-2");
  });

  it("passes dm messages through the route seam and uses the bound session", async () => {
    resolveTelegramConversationRouteMock.mockReturnValue(
      createBoundRoute({
        accountId: "default",
        sessionKey: "agent:codex-acp:session-dm",
        agentId: "codex-acp",
      }),
    );

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 1,
        chat: { id: 1234, type: "private" },
        date: 1_700_000_000,
        text: "hello",
        from: { id: 42, first_name: "Alice" },
      },
    });

    expect(resolveTelegramConversationRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        chatId: 1234,
        isGroup: false,
        resolvedThreadId: undefined,
        replyThreadId: undefined,
        senderId: "42",
      }),
    );
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:codex-acp:session-dm");
  });
});
