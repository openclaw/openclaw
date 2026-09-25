// Line tests cover the media send core routes around the payload owner.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { lineOutboundAdapter } from "./outbound.js";
import { recordLineQuoteToken } from "./quote-tokens.js";
import { createLineSendReceipt } from "./send-receipt.js";

const mediaSend = vi.hoisted(() => vi.fn());

// outbound.runtime re-exports each of these from send.js, and the module fails to
// load if the mock leaves one out.
vi.mock("./send.js", () => ({
  createFlexMessage: vi.fn(),
  createLocationMessage: vi.fn(),
  createQuickReplyItems: vi.fn(),
  pushFlexMessage: vi.fn(),
  pushLocationMessage: vi.fn(),
  pushMessageLine: vi.fn(),
  pushMessagesLine: vi.fn(),
  pushTemplateMessage: vi.fn(),
  pushTextMessageWithQuickReplies: vi.fn(),
  sendMessageLine: mediaSend,
}));

const cfg = { channels: { line: {} } } as OpenClawConfig;

function sentMediaOptions(): { mediaUrl?: string; quoteToken?: string } {
  return expectDefined(mediaSend.mock.calls[0], "media send")[2];
}

describe("the media send core routes around the payload owner", () => {
  // A reply carrying one media url and no structured content never reaches
  // sendPayload: core sends it through outbound.sendMedia instead.
  it("quotes the caption of a media reply that answers a message", async () => {
    mediaSend.mockClear();
    mediaSend.mockResolvedValue({
      messageId: "m-media",
      chatId: "Coutbound",
      receipt: createLineSendReceipt({ messageId: "m-media", chatId: "Coutbound", kind: "text" }),
    });
    recordLineQuoteToken({
      accountId: "default",
      chatId: "Coutbound",
      messageId: "inbound-outbound-media",
      quoteToken: "token-outbound-media",
    });

    await lineOutboundAdapter.sendMedia!({
      cfg,
      to: "line:group:Coutbound",
      text: "here you go",
      mediaUrl: "https://example.com/image.jpg",
      replyToId: "inbound-outbound-media",
      accountId: "default",
    });

    expect(sentMediaOptions()).toMatchObject({
      mediaUrl: "https://example.com/image.jpg",
      quoteToken: "token-outbound-media",
    });
  });

  it("sends a media reply that answers nothing without a quote", async () => {
    mediaSend.mockClear();

    await lineOutboundAdapter.sendMedia!({
      cfg,
      to: "line:group:Cplain",
      text: "just a picture",
      mediaUrl: "https://example.com/image.jpg",
      accountId: "default",
    });

    expect(sentMediaOptions().quoteToken).toBeUndefined();
  });
});
