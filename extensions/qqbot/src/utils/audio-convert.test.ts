import { describe, expect, it } from "vitest";
import {
  isVoiceAttachment,
  formatDuration,
  isAudioFile,
  shouldTranscodeVoice,
} from "./audio-convert.js";

describe("isVoiceAttachment", () => {
  it("returns true for content_type voice", () => {
    expect(isVoiceAttachment({ content_type: "voice" })).toBe(true);
  });

  it("returns true for audio/ content types", () => {
    expect(isVoiceAttachment({ content_type: "audio/silk" })).toBe(true);
    expect(isVoiceAttachment({ content_type: "audio/amr" })).toBe(true);
    expect(isVoiceAttachment({ content_type: "audio/wav" })).toBe(true);
    expect(isVoiceAttachment({ content_type: "audio/mpeg" })).toBe(true);
  });

  it("returns false for image content types", () => {
    expect(isVoiceAttachment({ content_type: "image/png" })).toBe(false);
  });

  it("returns true for voice file extensions", () => {
    expect(isVoiceAttachment({ filename: "voice.amr" })).toBe(true);
    expect(isVoiceAttachment({ filename: "voice.silk" })).toBe(true);
    expect(isVoiceAttachment({ filename: "voice.slk" })).toBe(true);
    expect(isVoiceAttachment({ filename: "voice.slac" })).toBe(true);
  });

  it("returns false for non-voice file extensions", () => {
    expect(isVoiceAttachment({ filename: "photo.jpg" })).toBe(false);
    expect(isVoiceAttachment({ filename: "doc.pdf" })).toBe(false);
  });

  it("returns false when both content_type and filename are absent", () => {
    expect(isVoiceAttachment({})).toBe(false);
  });

  it("returns false for undefined content_type and filename", () => {
    expect(isVoiceAttachment({ content_type: undefined, filename: undefined })).toBe(false);
  });

  it("is case-insensitive for file extensions", () => {
    expect(isVoiceAttachment({ filename: "voice.AMR" })).toBe(true);
    expect(isVoiceAttachment({ filename: "voice.SILK" })).toBe(true);
  });
});

describe("formatDuration", () => {
  it("formats seconds under 60", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(30000)).toBe("30s");
    expect(formatDuration(59000)).toBe("59s");
  });

  it("formats exact minutes", () => {
    expect(formatDuration(60000)).toBe("1m");
    expect(formatDuration(120000)).toBe("2m");
    expect(formatDuration(300000)).toBe("5m");
  });

  it("formats minutes with remaining seconds", () => {
    expect(formatDuration(90000)).toBe("1m 30s");
    expect(formatDuration(150000)).toBe("2m 30s");
    expect(formatDuration(61000)).toBe("1m 1s");
  });

  it("rounds to nearest second", () => {
    expect(formatDuration(1500)).toBe("2s");
    expect(formatDuration(500)).toBe("1s");
  });
});

describe("isAudioFile", () => {
  it("returns true for known audio extensions", () => {
    expect(isAudioFile("voice.silk")).toBe(true);
    expect(isAudioFile("voice.slk")).toBe(true);
    expect(isAudioFile("voice.amr")).toBe(true);
    expect(isAudioFile("voice.wav")).toBe(true);
    expect(isAudioFile("voice.mp3")).toBe(true);
    expect(isAudioFile("voice.ogg")).toBe(true);
    expect(isAudioFile("voice.opus")).toBe(true);
    expect(isAudioFile("voice.aac")).toBe(true);
    expect(isAudioFile("voice.flac")).toBe(true);
    expect(isAudioFile("voice.m4a")).toBe(true);
    expect(isAudioFile("voice.wma")).toBe(true);
    expect(isAudioFile("voice.pcm")).toBe(true);
  });

  it("returns false for non-audio extensions", () => {
    expect(isAudioFile("photo.jpg")).toBe(false);
    expect(isAudioFile("doc.pdf")).toBe(false);
    expect(isAudioFile("video.mp4")).toBe(false);
  });

  it("returns true when mimeType is voice or audio/", () => {
    expect(isAudioFile("file.txt", "voice")).toBe(true);
    expect(isAudioFile("file.txt", "audio/wav")).toBe(true);
    expect(isAudioFile("file.txt", "audio/mpeg")).toBe(true);
  });

  it("returns false when mimeType is not audio and extension is not audio", () => {
    expect(isAudioFile("file.txt", "text/plain")).toBe(false);
    expect(isAudioFile("file.jpg", "image/jpeg")).toBe(false);
  });

  it("prefers mimeType over extension when both are present", () => {
    expect(isAudioFile("file.jpg", "audio/wav")).toBe(true);
  });

  it("is case-insensitive for extensions", () => {
    expect(isAudioFile("voice.WAV")).toBe(true);
    expect(isAudioFile("voice.MP3")).toBe(true);
  });
});

describe("shouldTranscodeVoice", () => {
  it("returns false for QQ native voice MIME types", () => {
    expect(shouldTranscodeVoice("voice.silk", "audio/silk")).toBe(false);
    expect(shouldTranscodeVoice("voice.amr", "audio/amr")).toBe(false);
    expect(shouldTranscodeVoice("voice.wav", "audio/wav")).toBe(false);
    expect(shouldTranscodeVoice("voice.wav", "audio/wave")).toBe(false);
    expect(shouldTranscodeVoice("voice.wav", "audio/x-wav")).toBe(false);
    expect(shouldTranscodeVoice("voice.mp3", "audio/mpeg")).toBe(false);
    expect(shouldTranscodeVoice("voice.mp3", "audio/mp3")).toBe(false);
  });

  it("returns false for QQ native voice extensions", () => {
    expect(shouldTranscodeVoice("voice.silk")).toBe(false);
    expect(shouldTranscodeVoice("voice.slk")).toBe(false);
    expect(shouldTranscodeVoice("voice.amr")).toBe(false);
    expect(shouldTranscodeVoice("voice.wav")).toBe(false);
    expect(shouldTranscodeVoice("voice.mp3")).toBe(false);
  });

  it("returns true for non-native audio formats", () => {
    expect(shouldTranscodeVoice("voice.ogg")).toBe(true);
    expect(shouldTranscodeVoice("voice.opus")).toBe(true);
    expect(shouldTranscodeVoice("voice.aac")).toBe(true);
    expect(shouldTranscodeVoice("voice.flac")).toBe(true);
    expect(shouldTranscodeVoice("voice.m4a")).toBe(true);
  });

  it("returns false for non-audio files", () => {
    expect(shouldTranscodeVoice("photo.jpg")).toBe(false);
    expect(shouldTranscodeVoice("doc.pdf")).toBe(false);
  });

  it("prefers MIME type over extension for native formats", () => {
    expect(shouldTranscodeVoice("voice.ogg", "audio/wav")).toBe(false);
  });

  it("returns false when extension is native even if MIME is non-native", () => {
    expect(shouldTranscodeVoice("voice.wav", "audio/ogg")).toBe(false);
  });

  it("returns true when both MIME and extension are non-native audio", () => {
    expect(shouldTranscodeVoice("voice.ogg", "audio/ogg")).toBe(true);
    expect(shouldTranscodeVoice("voice.aac", "audio/aac")).toBe(true);
  });
});
