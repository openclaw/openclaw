import { describe, expect, it } from "vitest";
import { splitTelegramCaption, TELEGRAM_MAX_CAPTION_LENGTH } from "./caption.js";

describe("splitTelegramCaption", () => {
  it("returns empty parts for blank captions", () => {
    expect(splitTelegramCaption("   ")).toEqual({
      caption: undefined,
      followUpText: undefined,
    });
  });

  it("keeps short captions inline", () => {
    expect(splitTelegramCaption(" hello ")).toEqual({
      caption: "hello",
      followUpText: undefined,
    });
  });

  it("moves oversized captions into follow-up text", () => {
    const text = "x".repeat(TELEGRAM_MAX_CAPTION_LENGTH + 1);
    expect(splitTelegramCaption(text)).toEqual({
      caption: undefined,
      followUpText: text,
    });
  });
});
