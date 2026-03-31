import { describe, expect, it } from "vitest";
import { buildFishAudioSpeechProvider, isValidFishAudioVoiceId } from "./speech-provider.js";

describe("fish-audio speech provider", () => {
  describe("isValidFishAudioVoiceId", () => {
    it("accepts valid Fish Audio ref IDs (20-64 alphanumeric chars)", () => {
      const valid = [
        "8a2d42279389471993460b85340235c5", // 32 char hex - standard
        "0dad9e24630447cf97803f4beee10481", // 32 char hex
        "d8b0991f96b44e489422ca2ddf0bd31d", // 32 char hex - author id
        "aabbccddee112233445566778899aabb", // 32 char hex
        "abcdefABCDEF12345678901234567890", // mixed case alphanumeric
        "a1b2c3d4e5f6g7h8i9j0", // 20 char (minimum)
        "a".repeat(64), // 64 char (maximum)
      ];
      for (const v of valid) {
        expect(isValidFishAudioVoiceId(v), `expected valid: ${v}`).toBe(true);
      }
    });

    it("rejects invalid voice IDs", () => {
      const invalid = [
        "", // empty
        "abc123", // too short (6)
        "1234567890123456789", // 19 chars - below minimum
        "a".repeat(65), // too long (65)
        "8a2d4227-9389-4719-9346-0b85340235c5", // UUID with dashes
        "../../../etc/passwd", // path traversal
        "voice?param=value", // query string
        "hello world 1234567890", // spaces
        "abcdef!@#$%^&*()12345678", // special chars
      ];
      for (const v of invalid) {
        expect(isValidFishAudioVoiceId(v), `expected invalid: ${v}`).toBe(false);
      }
    });
  });

  describe("parseDirectiveToken", () => {
    const provider = buildFishAudioSpeechProvider();
    const parse = provider.parseDirectiveToken!;

    const policy = {
      enabled: true,
      allowVoice: true,
      allowModelId: true,
      allowVoiceSettings: true,
      allowProvider: true,
      allowText: true,
      allowNormalization: true,
      allowSeed: true,
    };

    it("handles provider-prefixed voice keys", () => {
      const voiceId = "8a2d42279389471993460b85340235c5";
      for (const key of ["fishaudio_voice", "fish_voice", "fishaudio_voiceid"]) {
        const result = parse({ key, value: voiceId, policy, currentOverrides: {} });
        expect(result.handled, `${key} should be handled`).toBe(true);
        expect(result.overrides?.voiceId).toBe(voiceId);
      }
    });

    it("handles provider-prefixed model keys", () => {
      for (const key of ["fishaudio_model", "fish_model"]) {
        const result = parse({ key, value: "s1", policy, currentOverrides: {} });
        expect(result.handled, `${key} should be handled`).toBe(true);
        expect(result.overrides?.model).toBe("s1");
      }
    });

    it("handles provider-prefixed speed keys", () => {
      for (const key of ["fishaudio_speed", "fish_speed"]) {
        const result = parse({ key, value: "1.5", policy, currentOverrides: {} });
        expect(result.handled, `${key} should be handled`).toBe(true);
        expect(result.overrides?.speed).toBe(1.5);
      }
    });

    it("handles provider-prefixed latency keys", () => {
      for (const key of ["fishaudio_latency", "fish_latency"]) {
        const result = parse({ key, value: "low", policy, currentOverrides: {} });
        expect(result.handled, `${key} should be handled`).toBe(true);
        expect(result.overrides?.latency).toBe("low");
      }
    });

    it("does NOT claim generic keys (voice, model, speed)", () => {
      for (const key of [
        "voice",
        "model",
        "speed",
        "voiceid",
        "voice_id",
        "modelid",
        "model_id",
        "latency",
        "temperature",
        "temp",
        "top_p",
        "topp",
      ]) {
        const result = parse({ key, value: "anything", policy, currentOverrides: {} });
        expect(result.handled, `generic key "${key}" should NOT be handled`).toBe(false);
      }
    });

    it("rejects invalid voice ID with warning", () => {
      const result = parse({ key: "fishaudio_voice", value: "bad!", policy, currentOverrides: {} });
      expect(result.handled).toBe(true);
      expect(result.warnings?.length).toBeGreaterThan(0);
      expect(result.overrides).toBeUndefined();
    });

    it("validates speed range", () => {
      const result = parse({ key: "fishaudio_speed", value: "5.0", policy, currentOverrides: {} });
      expect(result.handled).toBe(true);
      expect(result.warnings?.length).toBeGreaterThan(0);
    });

    it("rejects invalid latency values with warning instead of silently defaulting", () => {
      const result = parse({
        key: "fishaudio_latency",
        value: "fast",
        policy,
        currentOverrides: {},
      });
      expect(result.handled).toBe(true);
      expect(result.warnings?.length).toBeGreaterThan(0);
      expect(result.overrides).toBeUndefined();
    });

    it("accepts valid latency values", () => {
      for (const value of ["normal", "balanced", "low"]) {
        const result = parse({ key: "fishaudio_latency", value, policy, currentOverrides: {} });
        expect(result.handled).toBe(true);
        expect(result.overrides?.latency).toBe(value);
        expect(result.warnings).toBeUndefined();
      }
    });
  });
});
