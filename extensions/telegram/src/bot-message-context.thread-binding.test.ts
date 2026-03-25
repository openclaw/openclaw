import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const resolveByConversationMock = vi.fn();
  const touchMock = vi.fn();
  return {
    resolveByConversationMock,
    touchMock,
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    getSessionBindingService: () => ({
      bind: vi.fn(),
      getCapabilities: vi.fn(),
      listBySession: vi.fn(),
      resolveByConversation: (ref: unknown) => hoisted.resolveByConversationMock(ref),
      touch: (bindingId: string, at?: number) => hoisted.touchMock(bindingId, at),
      unbind: vi.fn(),
    }),
  };
});

let buildTelegramMessageContextForTest: typeof import("./bot-message-context.test-harness.js").buildTelegramMessageContextForTest;

describe("buildTelegramMessageContext bound conversation override", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ buildTelegramMessageContextForTest } =
      await import("./bot-message-context.test-harness.js"));
  });

  beforeEach(() => {
    hoisted.resolveByConversationMock.mockReset().mockReturnValue(null);
    hoisted.touchMock.mockReset();
  });

  it("routes forum topic messages to the bound session", async () => {
    hoisted.resolveByConversationMock.mockReturnValue({
      bindingId: "default:-100200300:topic:77",
      targetSessionKey: "agent:codex-acp:session-1",
    });

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

    expect(hoisted.resolveByConversationMock).toHaveBeenCalledWith({
      channel: "telegram",
      accountId: "default",
      conversationId: "-100200300:topic:77",
    });
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:codex-acp:session-1");
    expect(hoisted.touchMock).toHaveBeenCalledWith("default:-100200300:topic:77", undefined);
  });

  it("treats named-account bound conversations as explicit route matches", async () => {
    hoisted.resolveByConversationMock.mockReturnValue({
      bindingId: "work:-100200300:topic:77",
      targetSessionKey: "agent:codex-acp:session-2",
    });

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

    expect(ctx).not.toBeNull();
    expect(ctx?.route.accountId).toBe("work");
    expect(ctx?.route.matchedBy).toBe("binding.channel");
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:codex-acp:session-2");
    expect(hoisted.touchMock).toHaveBeenCalledWith("work:-100200300:topic:77", undefined);
  });

  it("routes dm messages to the bound session", async () => {
    hoisted.resolveByConversationMock.mockReturnValue({
      bindingId: "default:1234",
      targetSessionKey: "agent:codex-acp:session-dm",
    });

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 1,
        chat: { id: 1234, type: "private" },
        date: 1_700_000_000,
        text: "hello",
        from: { id: 42, first_name: "Alice" },
      },
    });

    expect(hoisted.resolveByConversationMock).toHaveBeenCalledWith({
      channel: "telegram",
      accountId: "default",
      conversationId: "1234",
    });
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:codex-acp:session-dm");
    expect(hoisted.touchMock).toHaveBeenCalledWith("default:1234", undefined);
  });
});
