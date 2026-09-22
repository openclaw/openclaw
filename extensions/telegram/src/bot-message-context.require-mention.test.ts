// Telegram tests cover bot message context.require mention plugin behavior.
import { describe, expect, it, vi } from "vitest";

const { buildTelegramMessageContextForTest } =
  await import("./bot-message-context.test-harness.js");
const { buildTelegramSelfSenderName } = await import("./group-history-window.js");

describe("buildTelegramMessageContext requireMention precedence", () => {
  function buildForumMessage(threadId = 99) {
    return {
      message_id: 1,
      chat: {
        id: -1001234567890,
        type: "supergroup" as const,
        title: "Forum",
        is_forum: true,
      },
      date: 1_700_000_000,
      text: "hello everyone",
      message_thread_id: threadId,
      from: { id: 42, first_name: "Alice" },
    };
  }

  it("lets explicit topic requireMention=false override group requireMention=true", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: buildForumMessage(),
      resolveGroupActivation: () => undefined,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: true },
        topicConfig: { requireMention: false },
      }),
    });

    expect(ctx?.ctxPayload.InboundEventKind).toBe("user_request");
  });

  it("keeps unmentioned always-on group messages as user requests by default", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: buildForumMessage(),
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    expect(ctx?.ctxPayload.InboundEventKind).toBe("user_request");
  });

  it("marks unmentioned always-on group messages as room events when configured", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      cfg: { messages: { groupChat: { unmentionedInbound: "room_event", mentionPatterns: [] } } },
      message: buildForumMessage(),
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    expect(ctx?.ctxPayload.InboundEventKind).toBe("room_event");
  });

  it("keeps explicit bot mentions as user requests in always-on room-event groups", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      cfg: { messages: { groupChat: { unmentionedInbound: "room_event", mentionPatterns: [] } } },
      message: {
        ...buildForumMessage(),
        text: "@bot status",
        entities: [{ type: "mention", offset: 0, length: "@bot".length }],
      },
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    expect(ctx?.ctxPayload.InboundEventKind).toBe("user_request");
    expect(ctx?.ctxPayload.WasMentioned).toBe(true);
    expect(ctx?.ctxPayload.ExplicitlyMentionedBot).toBe(true);
  });

  it("keeps ambient abort phrases as user requests", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      cfg: { messages: { groupChat: { unmentionedInbound: "room_event", mentionPatterns: [] } } },
      message: { ...buildForumMessage(), text: "stop" },
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

    expect(ctx?.ctxPayload.InboundEventKind).toBe("user_request");
  });

  it.each([
    { text: "@bot answer after watermark", kind: "user_request", expected: ["after watermark"] },
    {
      text: "ambient after watermark",
      kind: "room_event",
      expected: ["before self marker", "self marker body", "after watermark"],
    },
  ])(
    "selects retained context for $kind without mutating history",
    async ({ text, kind, expected }) => {
      const context = await buildTelegramMessageContextForTest({
        cfg: { messages: { groupChat: { unmentionedInbound: "room_event", mentionPatterns: [] } } },
        message: {
          ...buildForumMessage(99),
          message_id: 4,
          text,
          ...(kind === "user_request"
            ? { entities: [{ type: "mention", offset: 0, length: 4 }] }
            : {}),
        },
        historyLimit: 10,
        promptContext: [
          {
            label: "Conversation context",
            source: "telegram",
            type: "chat_window",
            payload: {
              messages: [
                { sender: "Alice", body: "before self marker", timestamp_ms: 1, message_id: "1" },
                {
                  sender: buildTelegramSelfSenderName("OpenClaw"),
                  body: "self marker body",
                  timestamp_ms: 2,
                  message_id: "2",
                },
                { sender: "Riley", body: "after watermark", timestamp_ms: 3, message_id: "3" },
              ],
            },
          },
        ],
        resolveGroupActivation: () => false,
        resolveGroupRequireMention: () => false,
        resolveTelegramGroupConfig: () => ({ groupConfig: { requireMention: false } }),
      });

      expect(context?.ctxPayload.InboundEventKind).toBe(kind);
      expect(context?.ctxPayload.InboundHistory?.map((entry) => entry.body)).toEqual(expected);
      expect(context?.ctxPayload.Body).not.toContain("before self marker");
    },
  );

  it("lets explicit topic requireMention=false override mention activation", async () => {
    const resolveGroupActivation = vi.fn(() => true);

    const ctx = await buildTelegramMessageContextForTest({
      message: buildForumMessage(),
      resolveGroupActivation,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: true },
        topicConfig: { requireMention: false },
      }),
    });

    if (!ctx?.ctxPayload) {
      throw new Error("expected Telegram context payload when topic disables requireMention");
    }
    expect(resolveGroupActivation).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:group:-1001234567890:topic:99",
      }),
    );
  });

  it("lets explicit topic requireMention=true override always activation", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: buildForumMessage(),
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: { requireMention: true },
      }),
    });

    expect(ctx).toBeNull();
  });

  it("keeps activation fallback when no topic requireMention is configured", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: buildForumMessage(),
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: true },
        topicConfig: { agentId: "main" },
      }),
    });

    if (!ctx) {
      throw new Error("expected Telegram context when topic config keeps agent");
    }
  });
});
