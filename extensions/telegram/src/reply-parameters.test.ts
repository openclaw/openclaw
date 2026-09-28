// Telegram tests cover reply parameters plugin behavior.
import { describe, expect, it } from "vitest";
import { buildTelegramThreadReplyParams } from "./reply-parameters.js";

describe("telegram reply parameters", () => {
  it("falls back to legacy reply id for blank quotes or mismatched quote sources", () => {
    expect(
      buildTelegramThreadReplyParams({
        replyToMessageId: 77,
        replyQuoteMessageId: 78,
        replyQuoteText: "quoted",
      }),
    ).toEqual({
      reply_to_message_id: 77,
      allow_sending_without_reply: true,
    });

    expect(
      buildTelegramThreadReplyParams({
        replyToMessageId: 77,
        replyQuoteText: " \n\t",
      }),
    ).toEqual({
      reply_to_message_id: 77,
      allow_sending_without_reply: true,
    });
  });
});
