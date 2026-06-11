import { describe, expect, it } from "vitest";
import { applyVoiceTranscripts, isAudioAttachment } from "./voice-message.js";

describe("voice-message (#13)", () => {
  it("detects audio content types", () => {
    expect(isAudioAttachment("audio/ogg")).toBe(true);
    expect(isAudioAttachment("AUDIO/MPEG")).toBe(true);
    expect(isAudioAttachment("audio/wav")).toBe(true);
    expect(isAudioAttachment("image/png")).toBe(false);
    expect(isAudioAttachment("application/pdf")).toBe(false);
    expect(isAudioAttachment(undefined)).toBe(false);
  });

  it("replaces the audio placeholder with a quoted transcript", () => {
    const out = applyVoiceTranscripts("<media:document>", [
      { transcript: "ship the release on friday", placeholder: "<media:document>" },
    ]);
    expect(out).toBe('🎙️ Voice message: "ship the release on friday"');
  });

  it("keeps surrounding real text and drops only the placeholder", () => {
    const out = applyVoiceTranscripts("see this <media:document>", [
      { transcript: "the budget numbers", placeholder: "<media:document>" },
    ]);
    expect(out).toBe('🎙️ Voice message: "the budget numbers"\n\nsee this');
  });

  it("handles multiple voice messages", () => {
    const out = applyVoiceTranscripts("<media:document><media:document>", [
      { transcript: "first", placeholder: "<media:document>" },
      { transcript: "second", placeholder: "<media:document>" },
    ]);
    expect(out).toBe('🎙️ Voice message: "first"\n🎙️ Voice message: "second"');
  });

  it("leaves the body unchanged when transcription produced nothing", () => {
    const body = "<media:document>";
    expect(applyVoiceTranscripts(body, [{ transcript: "", placeholder: "<media:document>" }])).toBe(
      body,
    );
    expect(applyVoiceTranscripts(body, [])).toBe(body);
  });
});
