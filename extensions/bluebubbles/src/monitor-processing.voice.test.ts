import { describe, expect, it } from "vitest";
import { isAudioCompatibleMedia } from "./monitor-processing.js";

describe("bluebubbles voice media gating", () => {
  it("treats audio mime types as voice-compatible", () => {
    expect(isAudioCompatibleMedia({ mediaType: "audio/mpeg" })).toBe(true);
    expect(isAudioCompatibleMedia({ mediaType: "audio/ogg; codecs=opus" })).toBe(true);
  });

  it("treats common audio file extensions as voice-compatible", () => {
    expect(isAudioCompatibleMedia({ mediaUrl: "/tmp/reply.m4a" })).toBe(true);
    expect(isAudioCompatibleMedia({ mediaUrl: "https://x.test/reply.opus?dl=1" })).toBe(true);
  });

  it("does not treat non-audio media as voice-compatible", () => {
    expect(isAudioCompatibleMedia({ mediaType: "image/png", mediaUrl: "/tmp/photo.png" })).toBe(
      false,
    );
    expect(isAudioCompatibleMedia({ mediaUrl: "https://x.test/photo.jpg" })).toBe(false);
  });
});
