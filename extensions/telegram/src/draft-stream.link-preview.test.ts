import { describe, expect, it } from "vitest";
import { createDraftStream, createMockDraftApi } from "./draft-stream.api.test-helpers.js";
import { renderTelegramProgressDraftPreview } from "./progress-draft-preview.js";

describe("Telegram draft link previews", () => {
  it("disables link previews on the streamed send and on every edit", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, {
      linkPreview: false,
      thread: { id: 42, scope: "dm" },
      replyToMessageId: 411,
      replyToMode: "all",
    });

    stream.update("see https://example.com");
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledWith(123, "see https://example.com", {
      message_thread_id: 42,
      reply_parameters: {
        message_id: 411,
        allow_sending_without_reply: true,
      },
      link_preview_options: { is_disabled: true },
    });

    // The edit matters as much as the send: Telegram re-enables the preview on
    // any edit that omits the field, and finalization skips the edit when the
    // streamed draft already equals the final text.
    stream.update("see https://example.com now");
    await stream.flush();

    expect(api.editMessageText).toHaveBeenCalledWith(123, 17, "see https://example.com now", {
      link_preview_options: { is_disabled: true },
    });
  });

  it.each([false, true])(
    "suppresses progress link cards through send, edit and stop (rich fallback: %s)",
    async (richMessages) => {
      const api = createMockDraftApi();
      const error = new Error("400: Bad Request: RICH_MESSAGE_URL_INVALID");
      api.raw.sendRichMessage.mockRejectedValue(error);
      api.raw.editMessageText.mockRejectedValue(error);
      const stream = createDraftStream(api, { richMessages });
      const preview = (text: string) =>
        renderTelegramProgressDraftPreview(
          { lines: [text] },
          { richMessages, toolProgress: true, maxLines: 5, maxLineChars: 300 },
        );

      stream.updatePreview(preview("Reading https://example.com"));
      await stream.flush();
      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123,
        richMessages
          ? "Reading https://example.com"
          : 'Reading <a href="https://example.com">https://example.com</a>',
        expect.objectContaining({ link_preview_options: { is_disabled: true } }),
      );

      stream.updatePreview(preview("Checking https://example.com"));
      await stream.flush();
      await stream.stop();
      expect(api.editMessageText).toHaveBeenLastCalledWith(
        123,
        17,
        richMessages
          ? "Checking https://example.com"
          : 'Checking <a href="https://example.com">https://example.com</a>',
        expect.objectContaining({ link_preview_options: { is_disabled: true } }),
      );
    },
  );

  it("restores the answer policy even when only the frame's link policy changes", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api);
    const text = "https://example.com";
    stream.updatePreview({ text, linkPreview: false });
    await stream.flush();
    stream.update(text);
    await stream.flush();
    expect(api.editMessageText).toHaveBeenLastCalledWith(123, 17, text);
  });

  it("keeps parse_mode alongside disabled link previews on the HTML transport", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, {
      linkPreview: false,
      renderText: (text) => ({ text: `<i>${text}</i>`, parseMode: "HTML" }),
    });

    stream.update("https://example.com");
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledWith(123, "<i>https://example.com</i>", {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });

    stream.update("https://example.com/two");
    await stream.flush();

    expect(api.editMessageText).toHaveBeenCalledWith(123, 17, "<i>https://example.com/two</i>", {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });
});
