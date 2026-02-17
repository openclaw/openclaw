import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, decryptJson, encrypt, encryptJson, parseEncryptionKey } from "./crypto.js";

const validKey = randomBytes(32);

describe("encrypt / decrypt", () => {
  it("should roundtrip plaintext correctly", () => {
    const plaintext = "hello world — secret token sk-ant-oat-12345";
    const encrypted = encrypt(plaintext, validKey);

    expect(encrypted.ciphertext).not.toBe(plaintext);
    expect(encrypted.iv).toBeTruthy();
    expect(encrypted.tag).toBeTruthy();

    const decrypted = decrypt(encrypted, validKey);
    expect(decrypted).toBe(plaintext);
  });

  it("should produce unique IVs for each encryption", () => {
    const encrypted1 = encrypt("same text", validKey);
    const encrypted2 = encrypt("same text", validKey);
    expect(encrypted1.iv).not.toBe(encrypted2.iv);
    expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
  });

  it("should fail with wrong key", () => {
    const encrypted = encrypt("secret", validKey);
    const wrongKey = randomBytes(32);
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it("should fail with tampered ciphertext", () => {
    const encrypted = encrypt("secret", validKey);
    const tampered = {
      ...encrypted,
      ciphertext: Buffer.from("tampered-data").toString("base64"),
    };
    expect(() => decrypt(tampered, validKey)).toThrow();
  });

  it("should fail with tampered auth tag", () => {
    const encrypted = encrypt("secret", validKey);
    const tampered = {
      ...encrypted,
      tag: randomBytes(16).toString("base64"),
    };
    expect(() => decrypt(tampered, validKey)).toThrow();
  });

  it("should reject key of wrong length", () => {
    const shortKey = randomBytes(16);
    expect(() => encrypt("test", shortKey)).toThrow(/32 bytes/);
    expect(() => decrypt({ ciphertext: "", iv: "", tag: "" }, shortKey)).toThrow(/32 bytes/);
  });

  it("should handle empty string", () => {
    const encrypted = encrypt("", validKey);
    const decrypted = decrypt(encrypted, validKey);
    expect(decrypted).toBe("");
  });

  it("should handle large payloads", () => {
    const large = "x".repeat(100_000);
    const encrypted = encrypt(large, validKey);
    const decrypted = decrypt(encrypted, validKey);
    expect(decrypted).toBe(large);
  });
});

describe("encryptJson / decryptJson", () => {
  it("should roundtrip JSON objects", () => {
    const data = {
      type: "oauth",
      provider: "anthropic",
      access: "sk-ant-oat-test",
      refresh: "refresh-token",
      expires: Date.now() + 3600_000,
    };
    const encrypted = encryptJson(data, validKey);
    const decrypted = decryptJson(encrypted, validKey);
    expect(decrypted).toEqual(data);
  });

  it("should roundtrip nested objects", () => {
    const data = { profiles: { "a:b": { type: "api_key", key: "sk-123" } } };
    const encrypted = encryptJson(data, validKey);
    const decrypted = decryptJson(encrypted, validKey);
    expect(decrypted).toEqual(data);
  });
});

describe("parseEncryptionKey", () => {
  it("should parse valid 64-char hex string", () => {
    const hex = randomBytes(32).toString("hex");
    expect(hex).toHaveLength(64);
    const key = parseEncryptionKey(hex);
    expect(key).toBeInstanceOf(Buffer);
    expect(key?.length).toBe(32);
  });

  it("should parse valid base64 string", () => {
    const b64 = randomBytes(32).toString("base64");
    const key = parseEncryptionKey(b64);
    expect(key).toBeInstanceOf(Buffer);
    expect(key?.length).toBe(32);
  });

  it("should return null for undefined/empty", () => {
    expect(parseEncryptionKey(undefined)).toBeNull();
    expect(parseEncryptionKey("")).toBeNull();
    expect(parseEncryptionKey("   ")).toBeNull();
  });

  it("should return null for invalid input", () => {
    expect(parseEncryptionKey("too-short")).toBeNull();
    expect(parseEncryptionKey("not-hex-and-not-base64!!")).toBeNull();
  });

  it("should trim whitespace", () => {
    const hex = randomBytes(32).toString("hex");
    const key = parseEncryptionKey(`  ${hex}  `);
    expect(key).toBeInstanceOf(Buffer);
    expect(key?.length).toBe(32);
  });
});
