import { describe, expect, it } from "vitest";
import { resolvePreferredTtsVoice } from "./tts-provider-voice.js";

describe("resolvePreferredTtsVoice", () => {
  it.each<{ provider: string; settings: Record<string, string>; expected: string }>([
    { provider: "openai", settings: { speakerVoice: "coral" }, expected: "coral" },
    { provider: "elevenlabs", settings: { speakerVoiceId: "voice-123" }, expected: "voice-123" },
    {
      provider: "openai",
      settings: { voice: "legacy-voice", voiceId: "legacy-id" },
      expected: "legacy-voice",
    },
  ])("resolves $provider voice $expected", ({ provider, settings, expected }) => {
    expect(
      resolvePreferredTtsVoice({ tts: { provider, providers: { [provider]: settings } } }),
    ).toBe(expected);
  });
});
