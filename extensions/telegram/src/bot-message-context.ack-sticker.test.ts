import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

const baseCfg = {
  agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
  channels: {
    telegram: {
      botToken: "test-token",
      dmPolicy: "open",
      allowFrom: ["*"],
    },
  },
  messages: { groupChat: { mentionPatterns: [] }, ackReactionScope: "group-mentions" },
};

describe("Telegram ackSticker context", () => {
  it("sends a silent direct ack sticker and records the sent message id", async () => {
    const sendSticker = vi.fn(async (_chatId, _fileId, _params) => ({
      message_id: 1001,
      chat: { id: 123 },
    }));
    const ctx = await buildTelegramMessageContextForTest({
      message: { chat: { id: 123, type: "private" }, text: "hello" },
      cfg: {
        ...baseCfg,
        channels: {
          telegram: {
            ...baseCfg.channels.telegram,
            ackSticker: { fileId: " sticker-file ", scope: "direct" },
          },
        },
      },
      botApi: { sendSticker },
    });

    await expect(ctx?.ackSticker?.ackStickerPromise).resolves.toEqual({
      messageId: "1001",
      chatId: "123",
    });
    expect(sendSticker).toHaveBeenCalledWith("123", "sticker-file", {
      disable_notification: true,
    });
  });

  it("does not send when a scoped override disables inherited ack stickers", async () => {
    const sendSticker = vi.fn(async () => ({ message_id: 1001, chat: { id: -100123 } }));
    const ctx = await buildTelegramMessageContextForTest({
      message: { chat: { id: -100123, type: "supergroup" }, text: "@bot hello" },
      cfg: {
        ...baseCfg,
        channels: {
          telegram: {
            ...baseCfg.channels.telegram,
            ackSticker: { fileId: "channel-sticker", scope: "all" },
          },
        },
      },
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: true, ackSticker: { scope: "off" } },
        topicConfig: undefined,
      }),
      options: { forceWasMentioned: true },
      botApi: { sendSticker },
    });

    expect(ctx?.ackSticker).toBeNull();
    expect(sendSticker).not.toHaveBeenCalled();
  });
});
