import { describe, expect, it } from "vitest";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import {
  baseDeliveryParams,
  createDeps,
  createQuickReply,
  LINE_TEST_CFG,
} from "./auto-reply-delivery.test-helpers.js";
import { createRuntime } from "./channel.sendPayload.test-support.js";
import { lineOutboundAdapter } from "./outbound.js";
import { recordLineQuoteToken } from "./quote-tokens.js";
import { setLineRuntime } from "./runtime.js";
import { buildTemplateMessageFromPayload } from "./template-messages.js";
import type { LineChannelData } from "./types.js";

const lineData = {
  templateMessage: {
    type: "carousel",
    columns: [
      {
        title: "First",
        text: "A",
        actions: [{ type: "message", label: "One", data: "one" }],
      },
      {
        text: "B",
        actions: [{ type: "message", label: "Two", data: "two" }],
      },
    ],
  },
} satisfies LineChannelData;

const fallbackText = "First: A (One)\nB (Two)";

function createOutboundRuntime() {
  const buildTemplate = buildTemplateMessageFromPayload;
  const { runtime, mocks } = createRuntime();
  mocks.buildTemplateMessageFromPayload.mockImplementation(buildTemplate);
  mocks.resolveTextChunkLimit.mockReturnValue(5000);
  setLineRuntime(runtime);
  return mocks;
}

function sendCarousel(to: string, text = "", quickReplies?: string[], replyToId?: string) {
  return lineOutboundAdapter.sendPayload!({
    to,
    text,
    payload: { text, channelData: { line: { ...lineData, quickReplies } } },
    replyToId,
    accountId: "default",
    cfg: { channels: { line: {} } },
  });
}

function recordQuote(chatId: string, messageId: string, quoteToken?: string) {
  recordLineQuoteToken({ accountId: "default", chatId, messageId, quoteToken });
}

describe("LINE carousel fallback delivery", () => {
  it.each(["", "After"])(
    "quotes the direct carousel fallback once when the following text is %j",
    async (text) => {
      const { pushMessageLine, pushTemplateMessage } = createOutboundRuntime();
      recordQuote("Ucarousel", "m-carousel", "q-carousel");

      await sendCarousel("line:user:Ucarousel", text, undefined, "m-carousel");

      expect(pushTemplateMessage).not.toHaveBeenCalled();
      expect(pushMessageLine).toHaveBeenNthCalledWith(
        1,
        "line:user:Ucarousel",
        fallbackText,
        expect.objectContaining({ quoteToken: "q-carousel" }),
      );
      expect(pushMessageLine).toHaveBeenCalledTimes(text ? 2 : 1);
      if (text) {
        expect(pushMessageLine).toHaveBeenNthCalledWith(
          2,
          "line:user:Ucarousel",
          text,
          expect.not.objectContaining({ quoteToken: expect.anything() }),
        );
      }
    },
  );

  it.each([undefined, "q-carousel-quick"])(
    "keeps quick replies inline with quote %j",
    async (quoteToken) => {
      const { pushMessagesLine, pushMessageLine, pushTemplateMessage } = createOutboundRuntime();
      const to = `line:user:Ucarousel-${quoteToken ?? "unquoted"}`;
      recordQuote(to, "m-carousel-quick", quoteToken);

      await sendCarousel(to, "", ["Continue"], quoteToken ? "m-carousel-quick" : undefined);

      expect(pushTemplateMessage).not.toHaveBeenCalled();
      expect(pushMessageLine).not.toHaveBeenCalled();
      expect(pushMessagesLine).toHaveBeenCalledExactlyOnceWith(
        to,
        [
          {
            type: "text",
            text: fallbackText,
            quickReply: createQuickReply("Continue"),
            ...(quoteToken ? { quoteToken } : {}),
          },
        ],
        expect.any(Object),
      );
    },
  );

  it("keeps the auto-reply fallback and ordinary text in the same reply", async () => {
    const { replyMessageLine } = createDeps({ buildTemplateMessageFromPayload });

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "After", channelData: { line: lineData } },
      lineData,
    });

    expect(replyMessageLine).toHaveBeenCalledExactlyOnceWith(
      "token",
      [
        { type: "text", text: "After" },
        { type: "text", text: fallbackText },
      ],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });
});
