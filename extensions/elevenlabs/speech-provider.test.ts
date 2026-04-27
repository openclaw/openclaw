import { describe, expect, it } from "vitest";
import {
  buildElevenLabsSpeechProvider,
  deriveElevenLabsFileExtension,
  isValidVoiceId,
} from "./speech-provider.js";

describe("elevenlabs speech provider", () => {
  it("exposes the current ElevenLabs TTS model catalog", () => {
    const provider = buildElevenLabsSpeechProvider();

    expect(provider.models).toEqual(
      expect.arrayContaining(["eleven_v3", "eleven_multilingual_v2"]),
    );
  });

  it("validates ElevenLabs voice ID length and character rules", () => {
    const cases = [
      { value: "pMsXgVXv3BLzUgSXRplE", expected: true },
      { value: "21m00Tcm4TlvDq8ikWAM", expected: true },
      { value: "VoiceAlias1234567890", expected: true },
      { value: "a1b2c3d4e5", expected: true },
      { value: "a".repeat(40), expected: true },
      { value: "", expected: false },
      { value: "abc", expected: false },
      { value: "123456789", expected: false },
      { value: "a".repeat(41), expected: false },
      { value: "a".repeat(100), expected: false },
      { value: "pMsXgVXv3BLz-gSXRplE", expected: false },
      { value: "pMsXgVXv3BLz_gSXRplE", expected: false },
      { value: "pMsXgVXv3BLz gSXRplE", expected: false },
      { value: "../../../etc/passwd", expected: false },
      { value: "voice?param=value", expected: false },
    ] as const;
    for (const testCase of cases) {
      expect(isValidVoiceId(testCase.value), testCase.value).toBe(testCase.expected);
    }
  });

  // Regression for https://github.com/openclaw/openclaw/issues/72506: when the
  // caller (or channel) overrides `outputFormat`, the resolved on-disk extension
  // must match the codec — otherwise downstream channels (e.g. BlueBubbles)
  // reject mp3 audio that arrives with a `.opus` filename.
  it("derives fileExtension from the resolved outputFormat codec", () => {
    expect(deriveElevenLabsFileExtension("mp3_44100_128")).toBe(".mp3");
    expect(deriveElevenLabsFileExtension("mp3_22050_32")).toBe(".mp3");
    expect(deriveElevenLabsFileExtension("opus_48000_64")).toBe(".opus");
    expect(deriveElevenLabsFileExtension("opus_48000_32")).toBe(".opus");
    expect(deriveElevenLabsFileExtension("flac_44100")).toBe(".flac");
    expect(deriveElevenLabsFileExtension("pcm_44100")).toBe(".wav");
    expect(deriveElevenLabsFileExtension("ulaw_8000")).toBe(".wav");
    expect(deriveElevenLabsFileExtension("MP3_44100_128")).toBe(".mp3");
  });

  it("falls back to mp3 for unknown output format codecs", () => {
    expect(deriveElevenLabsFileExtension("unknown_format")).toBe(".mp3");
    expect(deriveElevenLabsFileExtension("")).toBe(".mp3");
  });
});
