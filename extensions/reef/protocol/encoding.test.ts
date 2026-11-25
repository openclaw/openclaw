import { describe, expect, it } from "vitest";
import { base64, base64url, fromBase64, fromBase64url } from "./encoding.js";

describe("Reef binary encoding", () => {
  it("preserves canonical wire bytes", () => {
    for (const [bytes, encoded, urlEncoded] of [
      [[], "", ""],
      [[102], "Zg==", "Zg"],
      [[102, 111], "Zm8=", "Zm8"],
      [[251, 255, 255], "+///", "-___"],
    ] as const) {
      const value = Uint8Array.from(bytes);
      expect(base64(value)).toBe(encoded);
      expect(base64url(value)).toBe(urlEncoded);
      expect(fromBase64(encoded)).toEqual(value);
      expect(fromBase64url(urlEncoded)).toEqual(value);
    }
  });

  it("rejects invalid syntax and noncanonical padding", () => {
    for (const [decode, values, message] of [
      [fromBase64, ["Zg", "Zg==\n", "-___"], "invalid base64"],
      [fromBase64, ["Zh==", "Zm9="], "non-canonical base64"],
      [fromBase64url, ["A", "Zg=", "Zg\n", "+///"], "invalid base64url"],
      [fromBase64url, ["Zh", "Zm9"], "invalid base64url padding"],
    ] as const) {
      for (const value of values) {
        expect(() => decode(value), value).toThrow(message);
      }
    }
  });
});
