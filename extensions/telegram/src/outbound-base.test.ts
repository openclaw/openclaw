import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it, vi } from "vitest";
import { telegramChannelOutbound } from "./outbound-base.js";
import { clearTelegramRuntime, setTelegramRuntime } from "./runtime.js";

function createCfg(): OpenClawConfig {
  return {
    channels: {
      telegram: {
        enabled: true,
        accounts: {
          ops: { botToken: "token-ops" },
        },
      },
    },
  } as OpenClawConfig;
}

function installSendMessageSpy(sendMessageTelegram: ReturnType<typeof vi.fn>) {
  setTelegramRuntime({
    channel: {
      telegram: {
        sendMessageTelegram,
        text: {
          chunkMarkdownText: (text: string) => [text],
        },
      },
    },
    logging: {
      shouldLogVerbose: () => false,
    },
  } as never);
  return sendMessageTelegram;
}

describe("telegramChannelOutbound", () => {
  it("forwards mediaLocalRoots to sendMessageTelegram for outbound media sends", async () => {
    const sendMessageTelegram = installSendMessageSpy(
      vi.fn(async () => ({ messageId: "tg-1", chatId: "12345" })),
    );

    const result = await telegramChannelOutbound.attachedResults.sendMedia({
      cfg: createCfg(),
      to: "12345",
      text: "hello",
      mediaUrl: "/tmp/image.png",
      mediaLocalRoots: ["/tmp/agent-root"],
      accountId: "ops",
    });

    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "12345",
      "hello",
      expect.objectContaining({
        mediaUrl: "/tmp/image.png",
        mediaLocalRoots: ["/tmp/agent-root"],
      }),
    );
    expect(result).toMatchObject({ messageId: "tg-1" });
    clearTelegramRuntime();
  });

  it("preserves buttons for outbound text payload sends", async () => {
    const sendMessageTelegram = installSendMessageSpy(
      vi.fn(async () => ({ messageId: "tg-2", chatId: "12345" })),
    );

    const result = await telegramChannelOutbound.base.sendPayload({
      cfg: createCfg(),
      to: "12345",
      payload: {
        text: "Approval required",
        channelData: {
          telegram: {
            buttons: [[{ text: "Allow Once", callback_data: "/approve abc allow-once" }]],
          },
        },
      },
      accountId: "ops",
    });

    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "12345",
      "Approval required",
      expect.objectContaining({
        buttons: [[{ text: "Allow Once", callback_data: "/approve abc allow-once" }]],
      }),
    );
    expect(result).toMatchObject({ channel: "telegram", messageId: "tg-2" });
    clearTelegramRuntime();
  });

  it("sends outbound payload media lists and keeps buttons on the first message only", async () => {
    const sendMessageTelegram = installSendMessageSpy(
      vi
        .fn()
        .mockResolvedValueOnce({ messageId: "tg-3", chatId: "12345" })
        .mockResolvedValueOnce({ messageId: "tg-4", chatId: "12345" }),
    );

    const result = await telegramChannelOutbound.base.sendPayload({
      cfg: createCfg(),
      to: "12345",
      payload: {
        text: "Approval required",
        mediaUrls: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
        channelData: {
          telegram: {
            quoteText: "quoted",
            buttons: [[{ text: "Allow Once", callback_data: "/approve abc allow-once" }]],
          },
        },
      },
      mediaLocalRoots: ["/tmp/media"],
      accountId: "ops",
      silent: true,
    });

    expect(sendMessageTelegram).toHaveBeenCalledTimes(2);
    expect(sendMessageTelegram).toHaveBeenNthCalledWith(
      1,
      "12345",
      "Approval required",
      expect.objectContaining({
        mediaUrl: "https://example.com/1.jpg",
        mediaLocalRoots: ["/tmp/media"],
        quoteText: "quoted",
        silent: true,
        buttons: [[{ text: "Allow Once", callback_data: "/approve abc allow-once" }]],
      }),
    );
    expect(sendMessageTelegram).toHaveBeenNthCalledWith(
      2,
      "12345",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/2.jpg",
        mediaLocalRoots: ["/tmp/media"],
        quoteText: "quoted",
        silent: true,
      }),
    );
    expect(
      (sendMessageTelegram.mock.calls[1]?.[2] as Record<string, unknown>)?.buttons,
    ).toBeUndefined();
    expect(result).toMatchObject({ channel: "telegram", messageId: "tg-4" });
    clearTelegramRuntime();
  });

  it("forwards forceDocument to the underlying send call when channelData is present", async () => {
    const sendMessageTelegram = installSendMessageSpy(
      vi.fn(async () => ({ messageId: "tg-fd", chatId: "12345" })),
    );

    await telegramChannelOutbound.base.sendPayload({
      cfg: createCfg(),
      to: "12345",
      payload: {
        text: "here is an image",
        mediaUrls: ["https://example.com/photo.png"],
        channelData: { telegram: {} },
      },
      accountId: "ops",
      forceDocument: true,
    });

    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "12345",
      expect.any(String),
      expect.objectContaining({ forceDocument: true }),
    );
    clearTelegramRuntime();
  });
});
