import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as TelegramSend from "./send.js";

const hoisted = vi.hoisted(() => ({
  edit: vi.fn(),
  editMarkup: vi.fn(),
  register: vi.fn<(delivery: { finalize: (line: string) => void | Promise<void> }) => void>(),
}));
vi.mock("openclaw/plugin-sdk/question-gateway-runtime", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("openclaw/plugin-sdk/question-gateway-runtime")>();
  return {
    ...original,
    questionGatewayRuntime: {
      ...original.questionGatewayRuntime,
      registerChannelDelivery: hoisted.register,
    },
  };
});
vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof TelegramSend>()),
  editMessageReplyMarkupTelegram: hoisted.editMarkup,
  editMessageTelegram: hoisted.edit,
}));

import { telegramCaptionDeliveryMetadata } from "./caption.js";
import { createTelegramOutboundAdapter } from "./outbound-adapter.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";

const question = (text: string) => ({
  text,
  channelData: { askUser: { questionId: "ask_0123456789abcdef0123456789abcdef" } },
});

describe("Telegram question finalization", () => {
  const fixture = useTelegramHttpFixture();
  beforeEach(() => {
    hoisted.edit.mockReset();
    hoisted.editMarkup.mockReset();
    hoisted.register.mockReset();
  });

  it.each([
    [false, "123", "55"],
    [true, "-100123", "70"],
  ] as const)(
    "removes buttons before bounded finalization (caption: %s)",
    async (caption, chatId, messageId) => {
      const text = caption ? "Q".repeat(1000) : "x".repeat(5000);
      const statusLine = `Answered: ${caption ? "A".repeat(190) : "y".repeat(600)}`;
      const meta = { telegramDeliveredText: text, telegramHasInlineKeyboard: true };
      if (!caption) {
        telegramCaptionDeliveryMetadata.add(meta);
      }
      const parts = caption
        ? [{ platformMessageId: messageId, index: 0, kind: "media" as const, threadId: "77" }]
        : [
            { platformMessageId: "54", index: 0, kind: "media" as const },
            { platformMessageId: messageId, index: 1, kind: "text" as const },
          ];
      await createTelegramOutboundAdapter().afterDeliverPayload?.({
        cfg: {},
        target: {
          channel: "telegram",
          to: caption ? `${chatId}:topic:77` : chatId,
          accountId: "default",
        },
        payload: question(caption ? text : "Long preface\n\nPick one"),
        results: [
          ...(!caption
            ? [
                {
                  channel: "telegram" as const,
                  messageId: "54",
                  meta: { telegramDeliveredText: "Long preface", telegramHasInlineKeyboard: false },
                },
              ]
            : []),
          {
            channel: "telegram",
            messageId,
            target: { kind: "chat", id: chatId },
            meta,
            receipt: {
              primaryPlatformMessageId: messageId,
              platformMessageIds: parts.map((part) => part.platformMessageId),
              parts,
              sentAt: 0,
              ...(caption ? { threadId: "77" } : {}),
            },
          },
        ],
      });
      await hoisted.register.mock.lastCall?.[0].finalize(statusLine);
      expect(hoisted.editMarkup).toHaveBeenCalledWith(chatId, messageId, [], {
        cfg: {},
        accountId: "default",
        verbose: false,
      });
      const [editedChat, editedId, annotated, options] = hoisted.edit.mock.calls[0]!;
      expect([editedChat, editedId]).toEqual([chatId, messageId]);
      expect(typeof annotated).toBe("string");
      expect(annotated.length).toBeLessThanOrEqual(caption ? 1024 : 4000);
      expect(annotated).toContain(caption ? `\n\n${statusLine}` : "\n\nAnswered: ");
      if (caption) {
        expect(options).toMatchObject({ editMode: "caption" });
      } else {
        expect(options).not.toHaveProperty("editMode");
      }
      expect(hoisted.editMarkup.mock.invocationCallOrder[0]).toBeLessThan(
        hoisted.edit.mock.invocationCallOrder[0] ?? Infinity,
      );
    },
  );

  it("finalizes an accepted unthreaded media question by editing its caption", async () => {
    const send = await vi.importActual<typeof TelegramSend>("./send.js");
    hoisted.edit.mockImplementation(send.editMessageTelegram);
    hoisted.editMarkup.mockImplementation(send.editMessageReplyMarkupTelegram);
    const result = await send.sendMessageTelegram("123", "Choose one", {
      cfg: fixture.cfg,
      api: fixture.bot.api,
      mediaUrl: fixture.photoPath,
      mediaLocalRoots: [fixture.mediaDir],
      buttons: fixture.buttons,
    });
    await createTelegramOutboundAdapter().afterDeliverPayload?.({
      cfg: fixture.cfg,
      target: { channel: "telegram", to: "123" },
      payload: question("Choose one"),
      results: [{ channel: "telegram", ...result }],
    });
    await hoisted.register.mock.lastCall?.[0].finalize("Answered: yes");
    const edit = (method: string, fields: Record<string, unknown>) => ({
      method,
      fields: { chat_id: "123", message_id: Number(result.messageId), ...fields },
    });
    expect(fixture.requests).toMatchObject([
      { method: "sendPhoto" },
      edit("editMessageReplyMarkup", { reply_markup: { inline_keyboard: [] } }),
      edit("editMessageCaption", { caption: "Choose one\n\nAnswered: yes" }),
    ]);
  });
});
