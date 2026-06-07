// Telegram tests cover voice plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { splitTelegramCaption, TELEGRAM_MAX_CAPTION_LENGTH } from "./caption.js";
import { resolveTelegramVoiceSend } from "./voice.js";

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

describe("resolveTelegramVoiceSend", () => {
  it("skips voice when wantsVoice is false", () => {
    const logFallback = vi.fn();
    const result = resolveTelegramVoiceSend({
      wantsVoice: false,
      contentType: "audio/ogg",
      fileName: "voice.ogg",
      logFallback,
    });
    expect(result.useVoice).toBe(false);
    expect(logFallback).not.toHaveBeenCalled();
  });

  it("logs fallback for incompatible media", () => {
    const logFallback = vi.fn();
    const result = resolveTelegramVoiceSend({
      wantsVoice: true,
      contentType: "audio/wav",
      fileName: "track.wav",
      logFallback,
    });
    expect(result.useVoice).toBe(false);
    expect(logFallback).toHaveBeenCalledWith(
      "Telegram voice requested but media is audio/wav (track.wav); sending as audio file instead.",
    );
  });

  it("keeps voice when compatible", () => {
    const logFallback = vi.fn();
    const result = resolveTelegramVoiceSend({
      wantsVoice: true,
      contentType: "audio/ogg",
      fileName: "voice.ogg",
      logFallback,
    });
    expect(result.useVoice).toBe(true);
    expect(logFallback).not.toHaveBeenCalled();
  });

  it.each([
    { contentType: "audio/mpeg", fileName: "track.mp3" },
    { contentType: "audio/mp4", fileName: "track.m4a" },
  ])("keeps voice for compatible MIME $contentType", ({ contentType, fileName }) => {
    const logFallback = vi.fn();
    const result = resolveTelegramVoiceSend({
      wantsVoice: true,
      contentType,
      fileName,
      logFallback,
    });
    expect(result.useVoice).toBe(true);
    expect(logFallback).not.toHaveBeenCalled();
  });


  it("keeps voice for generated TTS MP3 output", () => {
    const logFallback = vi.fn();
    const result = resolveTelegramVoiceSend({
      wantsVoice: true,
      contentType: "audio/mpeg",
      fileName: "voice-1779334096572---a1d3761f-337e-4d9c-97bd-3edc67690a9a.mp3",
      logFallback,
    });
    expect(result.useVoice).toBe(true);
    expect(logFallback).not.toHaveBeenCalled();
  });
});
