import { describe, expect, it } from "vitest";
import { base58Decode, decodeRecoveryKey } from "./crypto-utils.js";

describe("base58Decode", () => {
  it("decodes a simple base58 string", () => {
    // "2" in base58 = byte value 1
    const result = base58Decode("2");
    expect(result.length).toBeGreaterThan(0);
    expect(result[result.length - 1]).toBe(1);
  });

  it("handles leading 1s as zero bytes", () => {
    const result = base58Decode("111");
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(0);
    expect(result[2]).toBe(0);
  });

  it("throws on invalid characters", () => {
    // '0', 'O', 'I', 'l' are not in the base58 alphabet
    expect(() => base58Decode("0")).toThrow("Invalid Base58 character");
    expect(() => base58Decode("O")).toThrow("Invalid Base58 character");
    expect(() => base58Decode("I")).toThrow("Invalid Base58 character");
    expect(() => base58Decode("l")).toThrow("Invalid Base58 character");
  });

  it("decodes a real recovery key to 35 bytes", () => {
    const key = "EsTN9CawofqamK3UyJY2FNCM46j4qZAyYiofeXBRoqkdMz8A";
    const decoded = base58Decode(key);
    // Recovery keys decode to 35 bytes: 2 prefix + 32 key + 1 parity
    expect(decoded.length).toBe(35);
    // Must start with 0x8b 0x01
    expect(decoded[0]).toBe(0x8b);
    expect(decoded[1]).toBe(0x01);
  });
});

describe("decodeRecoveryKey", () => {
  // Real recovery key from test (spaces in groups of 4)
  const VALID_KEY = "EsTN 9Caw ofoa mK3U yJY2 FNCM 46j4 qZAy Yiof eXBR oqkd Mz8A";

  it("decodes a valid recovery key with spaces", () => {
    const key = decodeRecoveryKey(VALID_KEY);
    expect(key.length).toBe(32);
    expect(key).toBeInstanceOf(Uint8Array);
  });

  it("decodes the same key without spaces", () => {
    const keyWithSpaces = decodeRecoveryKey(VALID_KEY);
    const keyWithout = decodeRecoveryKey(VALID_KEY.replace(/\s+/g, ""));
    expect(keyWithSpaces).toEqual(keyWithout);
  });

  it("rejects a key with wrong length", () => {
    expect(() => decodeRecoveryKey("EsTN9Caw")).toThrow("wrong length");
  });

  it("rejects a key with invalid base58 characters", () => {
    // '0' is not in base58
    expect(() => decodeRecoveryKey("0".repeat(48))).toThrow("Invalid Base58 character");
  });

  it("rejects a key with tampered content (bad parity)", () => {
    // Flip a character in the middle of a valid key
    const chars = VALID_KEY.replace(/\s+/g, "").split("");
    // Change a character (keeping it valid base58 but altering the decoded value)
    chars[10] = chars[10] === "a" ? "b" : "a";
    const tampered = chars.join("");
    expect(() => decodeRecoveryKey(tampered)).toThrow();
  });
});
