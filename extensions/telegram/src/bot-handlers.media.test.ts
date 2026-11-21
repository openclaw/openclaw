import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { describe, expect, it } from "vitest";
import { isMediaSizeLimitError, TelegramBotApiFileTooLargeError } from "./bot-handlers.media.js";

describe("isMediaSizeLimitError", () => {
  it.each([
    {
      name: "content-length limit",
      error: new MediaFetchError("max_bytes", "content length 11 exceeds maxBytes 10"),
      expected: true,
    },
    {
      name: "Telegram Bot API file limit",
      error: new TelegramBotApiFileTooLargeError(new Error("Bad Request: file is too big")),
      expected: true,
    },
    {
      name: "legacy untyped size error",
      error: new Error("media exceeds 20 MB limit"),
      expected: true,
    },
    {
      name: "fetch failure with misleading size text",
      error: new MediaFetchError("fetch_failed", "media exceeds 20 MB limit"),
      expected: false,
    },
    {
      name: "HTTP failure with misleading size text",
      error: new MediaFetchError("http_error", "media exceeds 20 MB limit", { status: 500 }),
      expected: false,
    },
  ])("classifies $name by its authoritative error code", ({ error, expected }) => {
    expect(isMediaSizeLimitError(error)).toBe(expected);
  });
});
