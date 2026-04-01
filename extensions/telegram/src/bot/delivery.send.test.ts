import { describe, expect, it, vi } from "vitest";

const { sendTelegramText } = await import("./delivery.send.ts");

describe("sendTelegramText", () => {
  it("sends through the shared telegram send wrapper with api override semantics", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 77,
      chat: { id: "123" },
    });
    const bot = { api: { sendMessage } } as const;
    const runtime = { log: vi.fn() } as const;

    const result = await sendTelegramText(bot as never, "123", "hello", runtime as never, {
      accountId: "default",
      textMode: "html",
      plainText: "hello",
      linkPreview: false,
      silent: true,
      replyToMessageId: 45,
      replyMarkup: {
        inline_keyboard: [[{ text: "Approve", callback_data: "approve" }]],
      },
    });

    expect(result).toBe(77);
    expect(sendMessage).toHaveBeenCalledWith("123", "hello", {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [[{ text: "Approve", callback_data: "approve" }]],
      },
      reply_to_message_id: 45,
      allow_sending_without_reply: true,
      disable_notification: true,
    });
  });

  it("passes DM topic ids through message_thread_id", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 88,
      chat: { id: "523353610" },
    });
    const bot = { api: { sendMessage } } as const;
    const runtime = { log: vi.fn() } as const;

    await sendTelegramText(bot as never, "523353610", "hello", runtime as never, {
      thread: { id: 9, scope: "dm" },
    });

    expect(sendMessage).toHaveBeenCalledWith("523353610", "hello", {
      parse_mode: "HTML",
      message_thread_id: 9,
    });
  });
});
