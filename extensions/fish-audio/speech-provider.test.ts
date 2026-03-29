import { describe, expect, it } from "vitest";
import { isValidFishAudioVoiceId } from "./speech-provider.js";

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
        expect(isValidFishAudioVoiceId(v), `expected invalid: ${v}`).toBe(
          false,
        );
      }
    });
  });
});
