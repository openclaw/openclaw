import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { describe, expect, it } from "vitest";
import { useTelegramHttpFixture } from "../send.telegram-http.test-support.js";
import { deliverReplies } from "./delivery.js";

describe("Telegram reply media load failure", () => {
  const fixture = useTelegramHttpFixture();
  const deliver = (error: Error) =>
    deliverReplies({
      cfg: fixture.cfg,
      bot: fixture.bot,
      runtime: fixture.runtime,
      chatId: "123",
      token: fixture.cfg.channels.telegram.botToken,
      replyToMode: "off",
      replies: [
        {
          text: "Report summary: all 12 checks passed.",
          mediaUrl: "https://example.com/report.png",
        },
      ],
      textLimit: 4096,
      mediaLoader: async () => {
        throw error;
      },
    });
  const sentTexts = () =>
    fixture.requests
      .filter(({ method }) => method === "sendMessage")
      .map(({ fields }) => fields.text);

  it("keeps the answer text with a receipt when only delivery-time media loading fails", async () => {
    const result = await deliver(
      new MediaFetchError(
        "fetch_failed",
        "Failed to fetch media from https://example.com/report.png",
      ),
    );

    expect(result.delivered).toBe(true);
    expect(sentTexts()).toEqual([
      "Report summary: all 12 checks passed.\n⚠️ report.png: Delivery failed. Try sending this file again.",
    ]);
  });

  it("does not turn other media errors into a text-only fallback", async () => {
    await expect(deliver(new Error("unexpected loader bug"))).rejects.toThrow(
      "unexpected loader bug",
    );
    expect(sentTexts()).toEqual([]);
  });
});
