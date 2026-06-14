// Telegram tests cover Bot API 10.1 rich message helper payloads.
import { describe, expect, it, vi } from "vitest";
import { sendTelegramRichMessage, sendTelegramRichMessageDraft } from "./rich-message.js";

describe("Telegram rich message helpers", () => {
  it("sends rich HTML messages through the raw Bot API method", async () => {
    const sendRichMessage = vi.fn().mockResolvedValue({ message_id: 11 });
    const methodParams = {
      message_thread_id: 42,
      reply_parameters: { message_id: 7 },
    };

    await expect(
      sendTelegramRichMessage({
        api: { raw: { sendRichMessage } } as never,
        chatId: 123,
        richMessage: {
          html: "<b>Hello</b>",
          is_rtl: true,
          skip_entity_detection: false,
        },
        methodParams,
      }),
    ).resolves.toEqual({ message_id: 11 });

    expect(sendRichMessage).toHaveBeenCalledWith({
      chat_id: 123,
      rich_message: {
        html: "<b>Hello</b>",
        is_rtl: true,
        skip_entity_detection: false,
      },
      ...methodParams,
    });
  });

  it("sends rich markdown drafts with caller-provided thread params", async () => {
    const sendRichMessageDraft = vi.fn().mockResolvedValue(true);
    const methodParams = { message_thread_id: 99 };

    await expect(
      sendTelegramRichMessageDraft({
        api: { raw: { sendRichMessageDraft } } as never,
        chatId: "123",
        draftId: 17,
        richMessage: {
          markdown: "**Hello**",
          skip_entity_detection: true,
        },
        methodParams,
      }),
    ).resolves.toBe(true);

    expect(sendRichMessageDraft).toHaveBeenCalledWith({
      chat_id: "123",
      draft_id: 17,
      rich_message: {
        markdown: "**Hello**",
        skip_entity_detection: true,
      },
      ...methodParams,
    });
  });

  it("keeps required rich message payload fields owned by the helper", async () => {
    const sendRichMessage = vi.fn().mockResolvedValue({ message_id: 11 });

    await sendTelegramRichMessage({
      api: { raw: { sendRichMessage } } as never,
      chatId: 123,
      richMessage: { html: "<b>Hello</b>" },
      methodParams: {
        chat_id: 999,
        rich_message: { markdown: "**override**" },
      },
    });

    expect(sendRichMessage).toHaveBeenCalledWith({
      chat_id: 123,
      rich_message: { html: "<b>Hello</b>" },
    });
  });

  it.each([{ html: "" }, { html: "   " }, { markdown: "" }, { markdown: "\n\t" }])(
    "rejects empty rich message content %#",
    async (richMessage) => {
      const sendRichMessage = vi.fn().mockResolvedValue({});

      await expect(
        sendTelegramRichMessage({
          api: { raw: { sendRichMessage } } as never,
          chatId: 123,
          richMessage: richMessage as never,
        }),
      ).rejects.toThrow(/must not be empty/);
      expect(sendRichMessage).not.toHaveBeenCalled();
    },
  );

  it("rejects rich messages that provide both html and markdown", async () => {
    const sendRichMessageDraft = vi.fn().mockResolvedValue(true);

    await expect(
      sendTelegramRichMessageDraft({
        api: { raw: { sendRichMessageDraft } } as never,
        chatId: 123,
        draftId: 17,
        richMessage: {
          html: "<b>Hello</b>",
          markdown: "**Hello**",
        } as never,
      }),
    ).rejects.toThrow("exactly one");
    expect(sendRichMessageDraft).not.toHaveBeenCalled();
  });
});
