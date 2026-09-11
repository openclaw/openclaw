// Line tests cover carousel text fallback across both delivery paths.
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import {
  baseDeliveryParams,
  createDeps,
  LINE_TEST_CFG,
} from "./auto-reply-delivery.test-helpers.js";
import { lineOutboundAdapter } from "./outbound.js";
import { recordLineQuoteToken } from "./quote-tokens.js";
import { setLineRuntime } from "./runtime.js";
import { createLineSendReceipt } from "./send-receipt.js";
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

function lineResult(messageId: string) {
  return {
    messageId,
    chatId: "line:user:1",
    receipt: createLineSendReceipt({ messageId, chatId: "line:user:1", kind: "text" }),
  };
}

function createOutboundRuntime() {
  const pushMessageLine = vi.fn(async (_to: string, _text: string, _options: unknown) =>
    lineResult("text"),
  );
  const pushMessagesLine = vi.fn(async () => lineResult("batch"));
  const pushTemplateMessage = vi.fn(async () => lineResult("template"));
  const runtime = {
    channel: {
      line: {
        buildTemplateMessageFromPayload,
        pushMessageLine,
        pushMessagesLine,
        pushTemplateMessage,
        pushFlexMessage: vi.fn(async () => lineResult("flex")),
        pushLocationMessage: vi.fn(async () => lineResult("location")),
        pushTextMessageWithQuickReplies: vi.fn(async () => lineResult("quick")),
        createQuickReplyItems: vi.fn((labels: string[]) => ({ items: labels })),
        sendMessageLine: vi.fn(async () => lineResult("media")),
      },
      text: {
        chunkMarkdownText: (text: string) => [text],
        resolveTextChunkLimit: () => 5000,
      },
    },
  } as unknown as PluginRuntime;

  return { runtime, pushMessageLine, pushMessagesLine, pushTemplateMessage };
}

describe("LINE carousel fallback delivery", () => {
  it.each(["", "After"])(
    "quotes the direct carousel fallback once when the following text is %j",
    async (text) => {
      const { runtime, pushMessageLine, pushTemplateMessage } = createOutboundRuntime();
      setLineRuntime(runtime);
      recordLineQuoteToken({
        accountId: "default",
        chatId: "Ucarousel",
        messageId: "m-carousel",
        quoteToken: "q-carousel",
      });

      await lineOutboundAdapter.sendPayload!({
        to: "line:user:Ucarousel",
        text,
        payload: { text, channelData: { line: lineData } },
        replyToId: "m-carousel",
        accountId: "default",
        cfg: { channels: { line: {} } },
      });

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

  it("quotes the carousel fallback once with inline quick replies", async () => {
    const { runtime, pushMessagesLine, pushMessageLine, pushTemplateMessage } =
      createOutboundRuntime();
    setLineRuntime(runtime);
    recordLineQuoteToken({
      accountId: "default",
      chatId: "Ucarousel-quick",
      messageId: "m-carousel-quick",
      quoteToken: "q-carousel-quick",
    });

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:Ucarousel-quick",
      text: "",
      payload: { channelData: { line: { ...lineData, quickReplies: ["Continue"] } } },
      replyToId: "m-carousel-quick",
      accountId: "default",
      cfg: { channels: { line: {} } },
    });

    expect(pushTemplateMessage).not.toHaveBeenCalled();
    expect(pushMessageLine).not.toHaveBeenCalled();
    expect(pushMessagesLine).toHaveBeenCalledExactlyOnceWith(
      "line:user:Ucarousel-quick",
      [
        {
          type: "text",
          text: fallbackText,
          quickReply: { items: ["Continue"] },
          quoteToken: "q-carousel-quick",
        },
      ],
      expect.any(Object),
    );
  });

  it("sends direct fallback before the ordinary text without calling template delivery", async () => {
    const { runtime, pushMessageLine, pushTemplateMessage } = createOutboundRuntime();
    setLineRuntime(runtime);

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:1",
      text: "After",
      payload: { text: "After", channelData: { line: lineData } },
      accountId: "default",
      cfg: { channels: { line: {} } },
    });

    expect(pushTemplateMessage).not.toHaveBeenCalled();
    expect(pushMessageLine.mock.calls.map((call) => call[1])).toEqual([fallbackText, "After"]);
  });

  it("keeps the auto-reply fallback and ordinary text in the same reply", async () => {
    const { deps, replyMessageLine } = createDeps({ buildTemplateMessageFromPayload });

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "After", channelData: { line: lineData } },
      lineData,
      deps,
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

  it("keeps quick replies inline on a direct textual fallback", async () => {
    const { runtime, pushMessagesLine, pushTemplateMessage } = createOutboundRuntime();
    setLineRuntime(runtime);

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:1",
      text: "",
      payload: {
        text: "",
        channelData: { line: { ...lineData, quickReplies: ["Continue"] } },
      },
      accountId: "default",
      cfg: { channels: { line: {} } },
    });

    expect(pushTemplateMessage).not.toHaveBeenCalled();
    expect(pushMessagesLine).toHaveBeenCalledWith(
      "line:user:1",
      [{ type: "text", text: fallbackText, quickReply: { items: ["Continue"] } }],
      expect.any(Object),
    );
  });
});
