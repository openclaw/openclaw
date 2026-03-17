import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import { TELEGRAM_FORUM_SERVICE_FIELDS } from "./forum-service-message.js";
describe("buildTelegramMessageContext implicitMention forum service messages", () => {
  async function buildGroupReplyCtx(params) {
    const BOT_ID = 7;
    return await buildTelegramMessageContextForTest({
      message: {
        message_id: 100,
        chat: { id: -1001234567890, type: "supergroup", title: "Forum Group" },
        date: 17e8,
        text: "hello everyone",
        from: { id: 42, first_name: "Alice" },
        reply_to_message: {
          message_id: 1,
          text: params.replyToMessageText ?? void 0,
          ...params.replyToMessageCaption != null ? { caption: params.replyToMessageCaption } : {},
          from: {
            id: params.replyFromId ?? BOT_ID,
            first_name: "OpenClaw",
            is_bot: params.replyFromIsBot ?? true
          },
          ...params.replyToMessageExtra
        }
      },
      resolveGroupActivation: () => true,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: true },
        topicConfig: void 0
      })
    });
  }
  it("does NOT trigger implicitMention for forum_topic_created service message", async () => {
    const ctx = await buildGroupReplyCtx({
      replyToMessageText: void 0,
      replyFromIsBot: true,
      replyToMessageExtra: {
        forum_topic_created: { name: "New Topic", icon_color: 7322096 }
      }
    });
    expect(ctx).toBeNull();
  });
  it.each(TELEGRAM_FORUM_SERVICE_FIELDS)(
    "does NOT trigger implicitMention for %s service message",
    async (field) => {
      const ctx = await buildGroupReplyCtx({
        replyToMessageText: void 0,
        replyFromIsBot: true,
        replyToMessageExtra: { [field]: {} }
      });
      expect(ctx).toBeNull();
    }
  );
  it("does NOT trigger implicitMention for forum_topic_closed service message", async () => {
    const ctx = await buildGroupReplyCtx({
      replyToMessageText: void 0,
      replyFromIsBot: true,
      replyToMessageExtra: { forum_topic_closed: {} }
    });
    expect(ctx).toBeNull();
  });
  it("does NOT trigger implicitMention for general_forum_topic_hidden service message", async () => {
    const ctx = await buildGroupReplyCtx({
      replyToMessageText: void 0,
      replyFromIsBot: true,
      replyToMessageExtra: { general_forum_topic_hidden: {} }
    });
    expect(ctx).toBeNull();
  });
  it("DOES trigger implicitMention for real bot replies (non-empty text)", async () => {
    const ctx = await buildGroupReplyCtx({
      replyToMessageText: "Here is my answer",
      replyFromIsBot: true
    });
    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.WasMentioned).toBe(true);
  });
  it("DOES trigger implicitMention for bot media messages with caption", async () => {
    const ctx = await buildGroupReplyCtx({
      replyToMessageText: void 0,
      replyToMessageCaption: "Check out this image",
      replyFromIsBot: true
    });
    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.WasMentioned).toBe(true);
  });
  it("DOES trigger implicitMention for bot sticker/voice (no text, no caption, no service field)", async () => {
    const ctx = await buildGroupReplyCtx({
      replyToMessageText: void 0,
      replyFromIsBot: true
      // No forum_topic_* fields → not a service message
    });
    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.WasMentioned).toBe(true);
  });
  it("does NOT trigger implicitMention when reply is from a different user", async () => {
    const ctx = await buildGroupReplyCtx({
      replyToMessageText: "some message",
      replyFromIsBot: false,
      replyFromId: 999
    });
    expect(ctx).toBeNull();
  });
});
