import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

const observedContext = {
  label: "Conversation context",
  source: "telegram",
  type: "chat_window",
  payload: {
    order: "chronological",
    relation: "selected_for_current_message",
    messages: [
      {
        message_id: "10",
        sender: "Pat",
        timestamp_ms: 1_700_000_000_000,
        body: "The launch password is violet-canoe.",
      },
    ],
  },
};

describe("Telegram observed group context", () => {
  it("does not suppress transcript replies when their cached projection is excluded", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: {
        message_id: 12,
        chat: { id: -1001234567890, type: "supergroup", title: "Launch" },
        text: "@bot Continue",
        entities: [{ type: "mention", offset: 0, length: 4 }],
      },
      historyLimit: 50,
      groupHistories: new Map([
        [
          "-1001234567890",
          [{ messageId: "11", sender: "Pat", timestamp: 1_700_000_001_000, body: "A new detail" }],
        ],
      ]),
      promptContext: [
        {
          ...observedContext,
          sessionTranscriptDedupeMessageIds: ["assistant-previous"],
          sessionTranscriptAssistantTextDedupeKeys: ["text:1700000000000:Previous answer"],
          payload: {
            ...observedContext.payload,
            messages: [
              {
                message_id: "10",
                sender: "OpenClaw (you)",
                timestamp_ms: 1_700_000_000_000,
                body: "Previous answer",
              },
            ],
          },
        },
      ],
    });
    const window = context?.ctxPayload.ChannelStructuredContext?.[0];
    expect(window?.payload).toMatchObject({
      messages: [expect.objectContaining({ body: "A new detail" })],
    });
    expect(window).not.toHaveProperty("sessionTranscriptDedupeMessageIds");
    expect(window).not.toHaveProperty("sessionTranscriptAssistantTextDedupeKeys");
  });

  it.each([
    { group: true, topic: undefined, retained: true },
    { group: true, topic: false, retained: false },
    { group: false, topic: true, retained: true },
    { group: false, topic: undefined, retained: false },
    { group: undefined, topic: undefined, retained: false },
  ])(
    "selects retained context with group=$group topic=$topic",
    async ({ group, topic, retained }) => {
      const context = await buildTelegramMessageContextForTest({
        message: {
          message_id: 11,
          chat: { id: -1001234567890, type: "supergroup", title: "Launch" },
          text: "@bot What password did we agree on?",
          entities: [{ type: "mention", offset: 0, length: 4 }],
        },
        promptContext: [observedContext],
        historyLimit: 50,
        groupHistories: new Map(),
        resolveGroupRequireMention: () => true,
        resolveTelegramGroupConfig: () => ({
          groupConfig: { requireMention: true, observeMessages: group },
          topicConfig: { observeMessages: topic },
        }),
      });
      expect(context?.ctxPayload.WasMentioned).toBe(true);
      expect(context?.ctxPayload.ChannelStructuredContext).toEqual(
        retained ? [observedContext] : undefined,
      );
    },
  );

  it("records unaddressed chatter without admitting a turn", async () => {
    const groupHistories = new Map();
    const context = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "Launch" },
        text: "The launch password is violet-canoe.",
      },
      groupHistories,
      historyLimit: 50,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: true, observeMessages: true },
        topicConfig: undefined,
      }),
    });
    expect(context).toBeNull();
    expect(groupHistories.get("-1001234567890")).toEqual([
      expect.objectContaining({ body: "The launch password is violet-canoe." }),
    ]);
  });
});
