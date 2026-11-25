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

  it("moves oversized captions into follow-up text", () => {
    const text = "x".repeat(TELEGRAM_CAPTION_LIMIT + 1);
    expect(splitTelegramCaption(text)).toEqual({
      caption: undefined,
      followUpText: text,
    });
  });

  it.each([
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
