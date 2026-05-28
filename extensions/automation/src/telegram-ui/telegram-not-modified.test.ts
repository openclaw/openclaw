import { describe, expect, it } from "vitest";
import { isTelegramMessageNotModifiedText } from "./telegram-not-modified.js";

describe("telegram not-modified detector", () => {
  it("matches canonical Telegram not-modified error", () => {
    expect(
      isTelegramMessageNotModifiedText(
        "400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      ),
    ).toBe(true);
  });

  it("matches escaped newline variant", () => {
    expect(isTelegramMessageNotModifiedText("Bad Request: message is\\nnot modified")).toBe(true);
  });

  it("matches ANSI colored variant", () => {
    expect(
      isTelegramMessageNotModifiedText("Bad Request: \u001b[31mmessage is not modified\u001b[0m"),
    ).toBe(true);
  });

  it("matches zero-width separator variant", () => {
    expect(
      isTelegramMessageNotModifiedText("Bad Request: message\u200Bis\u200Bnot\u200Bmodified"),
    ).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isTelegramMessageNotModifiedText("Bad Request: message can't be edited")).toBe(false);
    expect(isTelegramMessageNotModifiedText("Internal Server Error")).toBe(false);
  });
});
