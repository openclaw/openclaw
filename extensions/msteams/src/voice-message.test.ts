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

  it("keeps the placeholder of a clip whose transcription failed (mixed batch)", () => {
    // B13: only the transcribed clip's placeholder is consumed; the failed clip must stay visible
    // to the agent as an opaque attachment instead of vanishing entirely.
    const out = applyVoiceTranscripts("<media:document><media:document>", [
      { transcript: "first", placeholder: "<media:document>" },
      { transcript: "", placeholder: "<media:document>" },
    ]);
    expect(out).toBe('🎙️ Voice message: "first"\n\n<media:document>');
  });

  it("decrements a combined '(N files)' placeholder instead of leaving the counter behind", () => {
    // B13: two clips summarized as one "<media:document> (2 files)" token. Both transcribed -> the
    // whole token is consumed (no " (2 files)" residue).
    const both = applyVoiceTranscripts("<media:document> (2 files)", [
      { transcript: "first", placeholder: "<media:document>" },
      { transcript: "second", placeholder: "<media:document>" },
    ]);
    expect(both).toBe('🎙️ Voice message: "first"\n🎙️ Voice message: "second"');

    // One of the two failed -> the token decrements to a single bare placeholder for it.
    const oneFailed = applyVoiceTranscripts("<media:document> (2 files)", [
      { transcript: "first", placeholder: "<media:document>" },
      { transcript: "", placeholder: "<media:document>" },
    ]);
    expect(oneFailed).toBe('🎙️ Voice message: "first"\n\n<media:document>');

    // A clip transcribed alongside a non-audio document -> the document keeps a placeholder.
    const withPdf = applyVoiceTranscripts("<media:document> (3 files)", [
      { transcript: "only clip", placeholder: "<media:document>" },
    ]);
    expect(withPdf).toBe('🎙️ Voice message: "only clip"\n\n<media:document> (2 files)');
  });
});
