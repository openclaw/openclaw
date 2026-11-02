// Telegram tests cover reply parameters plugin behavior.
import { describe, expect, it, vi } from "vitest";
import * as helpers from "./bot/helpers.js";
import { buildTelegramThreadReplyParams } from "./reply-parameters.js";

describe("telegram reply parameters", () => {
  it("extends the freshly built thread parameters without copying them", () => {
    const buildThreadParams = vi.spyOn(helpers, "buildTelegramThreadParams");
    try {
      const params = buildTelegramThreadReplyParams({
        thread: { id: 42, scope: "forum" },
        replyToMessageId: 77,
      });

      expect(params).toEqual({
        message_thread_id: 42,
        reply_to_message_id: 77,
        allow_sending_without_reply: true,
      });
      expect(buildThreadParams).toHaveBeenCalledOnce();
      expect(params).toBe(buildThreadParams.mock.results[0]?.value);
    } finally {
      buildThreadParams.mockRestore();
    }
  });

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
