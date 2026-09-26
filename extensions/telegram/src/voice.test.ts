// Telegram tests cover voice plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { splitTelegramCaption } from "./caption.js";
import { resolveTelegramVoiceSend } from "./voice.js";

const TELEGRAM_CAPTION_LIMIT = 1024;

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
    const text = "x".repeat(TELEGRAM_CAPTION_LIMIT + 1);
    expect(splitTelegramCaption(text)).toEqual({
      caption: undefined,
      followUpText: text,
    });
  });

  it.each([
    {
      mode: "Markdown formatting",
      text: `**${"x".repeat(TELEGRAM_CAPTION_LIMIT - 2)}**`,
      renderedHtml: `<b>${"x".repeat(TELEGRAM_CAPTION_LIMIT - 2)}</b>`,
    },
    {
      mode: "HTML formatting",
      text: `<b>${"x".repeat(TELEGRAM_CAPTION_LIMIT - 2)}</b>`,
      renderedHtml: `<b>${"x".repeat(TELEGRAM_CAPTION_LIMIT - 2)}</b>`,
    },
    {
      mode: "HTML entities and links",
      text: `&amp;<a href="https://example.com/long-path">${"x".repeat(1022)}</a>`,
      renderedHtml: `&amp;<a href="https://example.com/long-path">${"x".repeat(1022)}</a>`,
    },
  ])("budgets $mode after Telegram parses entities", ({ text, renderedHtml }) => {
    expect(splitTelegramCaption(text, renderedHtml)).toEqual({
      caption: text,
      followUpText: undefined,
    });
  });

  it("counts visible Unicode in Telegram's UTF-16 code units", () => {
    const fitting = "😀".repeat(TELEGRAM_CAPTION_LIMIT / 2);
    const overflowing = `${fitting}😀`;

    expect(splitTelegramCaption(fitting, `<b>${fitting}</b>`).caption).toBe(fitting);
    expect(splitTelegramCaption(overflowing, `<b>${overflowing}</b>`)).toEqual({
      caption: undefined,
      followUpText: overflowing,
    });
  });
});

describe("resolveTelegramVoiceSend", () => {
  it.each([{ contentType: "audio/mp4", fileName: "track.m4a" }])(
    "keeps voice for compatible MIME $contentType",
    ({ contentType, fileName }) => {
      const logFallback = vi.fn();
      const result = resolveTelegramVoiceSend({
        wantsVoice: true,
        contentType,
        fileName,
        logFallback,
      });
      expect(result.useVoice).toBe(true);
      expect(logFallback).not.toHaveBeenCalled();
    },
  );
});
