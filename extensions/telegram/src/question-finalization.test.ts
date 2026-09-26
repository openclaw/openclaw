// Covers Telegram question delivery capture and native final edit.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as TelegramSend from "./send.js";

const hoisted = vi.hoisted(() => ({
  edit: vi.fn(),
  editMarkup: vi.fn(),
  registration: undefined as
    | { finalize: (statusLine: string) => void | Promise<void>; deliveryId: string }
    | undefined,
}));
vi.mock("openclaw/plugin-sdk/question-gateway-runtime", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("openclaw/plugin-sdk/question-gateway-runtime")>();
  return {
    ...original,
    questionGatewayRuntime: {
      ...original.questionGatewayRuntime,
      registerChannelDelivery: (registration: typeof hoisted.registration) => {
        hoisted.registration = registration;
      },
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
import { sendMessageTelegram } from "./send.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";

describe("Telegram question finalization", () => {
  const fixture = useTelegramHttpFixture();
  beforeEach(() => {
    hoisted.edit.mockReset();
    hoisted.editMarkup.mockReset();
    hoisted.registration = undefined;
  });

  it("removes buttons and appends terminal status", async () => {
    const deliveredText = "x".repeat(5000);
    const statusLine = `Answered: ${"y".repeat(600)}`;
    const deliveredMeta = {
      telegramDeliveredText: deliveredText,
      telegramHasInlineKeyboard: true,
    };
    telegramCaptionDeliveryMetadata.add(deliveredMeta);
    const outbound = createTelegramOutboundAdapter();
    await outbound.afterDeliverPayload?.({
      cfg: {},
      target: { channel: "telegram", to: "123", accountId: "default" },
      payload: {
        text: "Long preface\n\nPick one",
        mediaUrls: ["https://example.com/photo.jpg"],
        channelData: {
          askUser: { questionId: "ask_0123456789abcdef0123456789abcdef" },
        },
      },
      results: [
        {
          channel: "telegram",
          messageId: "54",
          target: { kind: "chat", id: "123" },
          meta: { telegramDeliveredText: "Long preface", telegramHasInlineKeyboard: false },
        },
        {
          channel: "telegram",
          messageId: "55",
          target: { kind: "chat", id: "123" },
          meta: deliveredMeta,
          receipt: {
            primaryPlatformMessageId: "55",
            platformMessageIds: ["54", "55"],
            parts: [
              { platformMessageId: "54", index: 0, kind: "media" },
              { platformMessageId: "55", index: 1, kind: "text" },
            ],
            sentAt: 0,
          },
        },
      ],
    });

    await hoisted.registration?.finalize(statusLine);
    expect(hoisted.editMarkup).toHaveBeenCalledWith("123", "55", [], {
      cfg: {},
      accountId: "default",
      verbose: false,
    });
    const annotatedText = hoisted.edit.mock.calls[0]?.[2] as string;
    expect(annotatedText.length).toBeLessThanOrEqual(4000);
    expect(annotatedText).toContain("\n\nAnswered: ");
    expect(hoisted.edit.mock.calls[0]?.[3]).not.toHaveProperty("editMode");
    expect(hoisted.editMarkup.mock.invocationCallOrder[0]).toBeLessThan(
      hoisted.edit.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it("finalizes an accepted unthreaded media question by editing its caption", async () => {
    const send = await vi.importActual<typeof TelegramSend>("./send.js");
    hoisted.edit.mockImplementation(send.editMessageTelegram);
    hoisted.editMarkup.mockImplementation(send.editMessageReplyMarkupTelegram);
    const result = await sendMessageTelegram("123", "Choose one", {
      cfg: fixture.cfg,
      api: fixture.bot.api,
      mediaUrl: fixture.photoPath,
      mediaLocalRoots: [fixture.mediaDir],
      buttons: fixture.buttons,
    });
    const outbound = createTelegramOutboundAdapter();

    await outbound.afterDeliverPayload?.({
      cfg: fixture.cfg,
      target: { channel: "telegram", to: "123" },
      payload: {
        text: "Choose one",
        mediaUrls: [fixture.photoPath],
        channelData: {
          askUser: { questionId: "ask_0123456789abcdef0123456789abcdef" },
        },
      },
      results: [{ channel: "telegram", ...result }],
    });

    await hoisted.registration?.finalize("Answered: yes");

    expect(fixture.requests.map(({ method }) => method)).toEqual([
      "sendPhoto",
      "editMessageReplyMarkup",
      "editMessageCaption",
    ]);
    expect(fixture.requests[1]?.fields).toMatchObject({
      chat_id: "123",
      message_id: Number(result.messageId),
      reply_markup: { inline_keyboard: [] },
    });
    expect(fixture.requests[2]?.fields).toMatchObject({
      chat_id: "123",
      message_id: Number(result.messageId),
      caption: "Choose one\n\nAnswered: yes",
    });
  });

  it("finalizes media-receipt questions as bounded captions", async () => {
    const deliveredText = "Q".repeat(1000);
    const statusLine = `Answered: ${"A".repeat(190)}`;
    const outbound = createTelegramOutboundAdapter();

    await outbound.afterDeliverPayload?.({
      cfg: {},
      target: { channel: "telegram", to: "-100123:topic:77", accountId: "default" },
      payload: {
        text: deliveredText,
        mediaUrls: ["https://example.com/photo.jpg"],
        channelData: {
          askUser: { questionId: "ask_0123456789abcdef0123456789abcdef" },
        },
      },
      results: [
        {
          channel: "telegram",
          messageId: "70",
          target: { kind: "chat", id: "-100123" },
          meta: { telegramDeliveredText: deliveredText, telegramHasInlineKeyboard: true },
          receipt: {
            primaryPlatformMessageId: "70",
            platformMessageIds: ["70"],
            parts: [{ platformMessageId: "70", index: 0, kind: "media", threadId: "77" }],
            threadId: "77",
            sentAt: 0,
          },
        },
      ],
    });

    await hoisted.registration?.finalize(statusLine);

    expect(hoisted.editMarkup).toHaveBeenCalledWith("-100123", "70", [], {
      cfg: {},
      accountId: "default",
      verbose: false,
    });
    expect(hoisted.edit).toHaveBeenCalledWith(
      "-100123",
      "70",
      expect.any(String),
      expect.objectContaining({ editMode: "caption" }),
    );
    const annotatedCaption = hoisted.edit.mock.calls[0]?.[2] as string;
    expect(annotatedCaption.length).toBeLessThanOrEqual(1024);
    expect(annotatedCaption).toContain(`\n\n${statusLine}`);
    expect(hoisted.editMarkup.mock.invocationCallOrder[0]).toBeLessThan(
      hoisted.edit.mock.invocationCallOrder[0] ?? Infinity,
    );
  });
});
