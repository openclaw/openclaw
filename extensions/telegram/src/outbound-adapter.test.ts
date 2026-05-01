import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageTelegramMock = vi.fn();
const pinMessageTelegramMock = vi.fn();

vi.mock("./send.js", () => ({
  pinMessageTelegram: (...args: unknown[]) => pinMessageTelegramMock(...args),
  sendMessageTelegram: (...args: unknown[]) => sendMessageTelegramMock(...args),
}));

import { telegramOutbound } from "./outbound-adapter.js";

describe("telegramOutbound", () => {
  beforeEach(() => {
    pinMessageTelegramMock.mockReset();
    sendMessageTelegramMock.mockReset();
  });

  it("forwards mediaLocalRoots in direct media sends", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-media" });

    const result = await telegramOutbound.sendMedia!({
      cfg: {} as never,
      to: "12345",
      text: "hello",
      mediaUrl: "/tmp/image.png",
      mediaLocalRoots: ["/tmp/agent-root"],
      accountId: "ops",
      replyToId: "900",
      threadId: "12",
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    expect(sendMessageTelegramMock).toHaveBeenCalledWith(
      "12345",
      "hello",
      expect.objectContaining({
        mediaUrl: "/tmp/image.png",
        mediaLocalRoots: ["/tmp/agent-root"],
        accountId: "ops",
        replyToMessageId: 900,
        messageThreadId: 12,
        textMode: "html",
      }),
    );
    expect(result).toEqual({ channel: "telegram", messageId: "tg-media" });
  });

  it("sends payload media in sequence and keeps buttons on the first message only", async () => {
    sendMessageTelegramMock
      .mockResolvedValueOnce({ messageId: "tg-1", chatId: "12345" })
      .mockResolvedValueOnce({ messageId: "tg-2", chatId: "12345" });

    const result = await telegramOutbound.sendPayload!({
      cfg: {} as never,
      to: "12345",
      text: "",
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
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    expect(sendMessageTelegramMock).toHaveBeenCalledTimes(2);
    expect(sendMessageTelegramMock).toHaveBeenNthCalledWith(
      1,
      "12345",
      "Approval required",
      expect.objectContaining({
        mediaUrl: "https://example.com/1.jpg",
        mediaLocalRoots: ["/tmp/media"],
        quoteText: "quoted",
        buttons: [[{ text: "Allow Once", callback_data: "/approve abc allow-once" }]],
      }),
    );
    expect(sendMessageTelegramMock).toHaveBeenNthCalledWith(
      2,
      "12345",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/2.jpg",
        mediaLocalRoots: ["/tmp/media"],
        quoteText: "quoted",
      }),
    );
    expect(
      (sendMessageTelegramMock.mock.calls[1]?.[2] as Record<string, unknown>)?.buttons,
    ).toBeUndefined();
    expect(result).toEqual({ channel: "telegram", messageId: "tg-2", chatId: "12345" });
  });

  it("uses interactive button labels as fallback text for button-only payloads", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-buttons", chatId: "12345" });

    const result = await telegramOutbound.sendPayload!({
      cfg: {} as never,
      to: "12345",
      text: "",
      payload: {
        interactive: {
          blocks: [{ type: "buttons", buttons: [{ label: "Approve", value: "approve" }] }],
        },
      },
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    expect(sendMessageTelegramMock).toHaveBeenCalledWith(
      "12345",
      "- Approve",
      expect.objectContaining({
        buttons: [[{ text: "Approve", callback_data: "approve" }]],
      }),
    );
    expect(result).toEqual({ channel: "telegram", messageId: "tg-buttons", chatId: "12345" });
  });

  it("sends rendered presentation payloads with direct notification buttons", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-direct", chatId: "12345" });
    const payload = {
      text: "Choose Approve, Revise, or Reject below.",
      presentation: {
        blocks: [
          {
            type: "buttons" as const,
            buttons: [
              { label: "Approve", value: "code-agent:approve", style: "primary" as const },
              { label: "Revise", value: "code-agent:revise", style: "secondary" as const },
              { label: "Reject", value: "code-agent:reject", style: "danger" as const },
            ],
          },
        ],
      },
    };
    const rendered = await telegramOutbound.renderPresentation!({
      payload,
      presentation: payload.presentation,
      ctx: {
        cfg: {} as never,
        to: "12345",
        text: payload.text,
        payload,
      },
    });

    const result = await telegramOutbound.sendPayload!({
      cfg: {} as never,
      to: "12345",
      text: payload.text,
      payload: rendered!,
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    expect(sendMessageTelegramMock).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("Choose Approve, Revise, or Reject below."),
      expect.objectContaining({
        buttons: [
          [
            { text: "Approve", callback_data: "code-agent:approve", style: "primary" },
            { text: "Revise", callback_data: "code-agent:revise", style: undefined },
            { text: "Reject", callback_data: "code-agent:reject", style: "danger" },
          ],
        ],
      }),
    );
    expect(result).toEqual({ channel: "telegram", messageId: "tg-direct", chatId: "12345" });
  });

  it("passes delivery pin notify requests to Telegram pinning", async () => {
    pinMessageTelegramMock.mockResolvedValueOnce({ ok: true, messageId: "tg-1", chatId: "12345" });

    await telegramOutbound.pinDeliveredMessage?.({
      cfg: {} as never,
      target: { channel: "telegram", to: "12345", accountId: "ops" },
      messageId: "tg-1",
      pin: { enabled: true, notify: true },
    });

    expect(pinMessageTelegramMock).toHaveBeenCalledWith(
      "12345",
      "tg-1",
      expect.objectContaining({
        accountId: "ops",
        notify: true,
        verbose: false,
      }),
    );
  });
});
