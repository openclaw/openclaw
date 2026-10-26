import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramCaptionDeliveryMetadata } from "./caption.js";
import { createTelegramOutboundAdapter } from "./outbound-adapter.js";
import type { TelegramSendResult } from "./send-message-types.js";
import { sendMessageTelegram } from "./send.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";

const register = vi.hoisted(() =>
  vi.fn<(delivery: { finalize: (line: string) => void | Promise<void> }) => void>(),
);
vi.mock("openclaw/plugin-sdk/question-gateway-runtime", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("openclaw/plugin-sdk/question-gateway-runtime")>();
  return {
    ...original,
    questionGatewayRuntime: {
      ...original.questionGatewayRuntime,
      registerChannelDelivery: register,
    },
  };
});

describe("Telegram question finalization", () => {
  const fixture = useTelegramHttpFixture();
  beforeEach(() => register.mockReset());

  it.each([false, true])(
    "clears controls before bounded HTTP finalization (caption=%s)",
    async (caption) => {
      const text = caption ? "Q".repeat(1000) : "x".repeat(8000);
      const statusLine = `Answered: ${(caption ? "A" : "y").repeat(caption ? 190 : 600)}`;
      const deliveries: TelegramSendResult[] = [];
      const result = await sendMessageTelegram("123", text, {
        cfg: fixture.cfg,
        api: fixture.bot.api,
        mediaUrl: fixture.photoPath,
        mediaLocalRoots: [fixture.mediaDir],
        buttons: fixture.buttons,
        onDeliveryResult: (delivery) => {
          deliveries.push(delivery);
        },
      });
      if (!caption) {
        expect(result.receipt?.parts.map((part) => part.kind)).toEqual(["media", "text", "text"]);
        assert(result.meta, "expected accepted text metadata");
        // The matching text receipt must outrank a stale media marker.
        telegramCaptionDeliveryMetadata.add(result.meta);
      }
      await createTelegramOutboundAdapter().afterDeliverPayload?.({
        cfg: fixture.cfg,
        target: { channel: "telegram", to: "123" },
        payload: {
          text,
          channelData: { askUser: { questionId: "ask_0123456789abcdef0123456789abcdef" } },
        },
        results: [...deliveries.slice(0, -1), result].map((delivery) =>
          Object.assign({ channel: "telegram" as const }, delivery),
        ),
      });
      await register.mock.lastCall?.[0].finalize(statusLine);
      const fields = { chat_id: "123", message_id: Number(result.messageId) };
      const annotated = caption
        ? `${"Q".repeat(822)}\n\n${statusLine}`
        : `${"x".repeat(3486)}\n\n${statusLine.slice(0, 512)}`;
      expect(fixture.requests.slice(-2)).toMatchObject([
        {
          method: "editMessageReplyMarkup",
          fields: { ...fields, reply_markup: { inline_keyboard: [] } },
        },
        {
          method: caption ? "editMessageCaption" : "editMessageText",
          fields: { ...fields, [caption ? "caption" : "text"]: annotated },
        },
      ]);
    },
  );
});
