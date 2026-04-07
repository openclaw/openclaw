import { describe, expect, it } from "vitest";
import { _test } from "./tts.js";

describe("speech-core TTS voice-note routing", () => {
  it("treats openclaw-weixin as a voice-note-capable channel", () => {
    expect(_test.supportsVoiceNoteReplies("openclaw-weixin")).toBe(true);
  });

  it("keeps non-voice-note channels on the regular audio-file path", () => {
    expect(_test.supportsVoiceNoteReplies("discord" as never)).toBe(false);
    expect(_test.supportsVoiceNoteReplies(null)).toBe(false);
  });
});
