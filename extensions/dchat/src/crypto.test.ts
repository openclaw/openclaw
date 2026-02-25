import { describe, expect, it } from "vitest";
import { byteArrayToKey, decryptAesGcm, encryptAesGcm, keyToByteArray } from "./crypto.js";

describe("AES-128-GCM crypto", () => {
  it("encrypts and decrypts round-trip", () => {
    const plaintext = Buffer.from("Hello, D-Chat!");
    const { ciphertext, key } = encryptAesGcm(plaintext);

    const decrypted = decryptAesGcm(ciphertext, key);
    expect(decrypted.toString()).toBe("Hello, D-Chat!");
  });

  it("produces different ciphertext for same plaintext", () => {
    const plaintext = Buffer.from("Same input");
    const result1 = encryptAesGcm(plaintext);
    const result2 = encryptAesGcm(plaintext);

    // Different random keys/nonces should produce different ciphertext
    expect(result1.ciphertext).not.toEqual(result2.ciphertext);
  });

  it("uses correct nonce and key sizes", () => {
    const { key, nonce } = encryptAesGcm(Buffer.from("test"));
    expect(key.length).toBe(16); // AES-128 = 16-byte key
    expect(nonce.length).toBe(12); // GCM standard nonce
  });

  it("ciphertext format: nonce (12B) + encrypted + auth tag (16B)", () => {
    const plaintext = Buffer.from("test data");
    const { ciphertext, nonce } = encryptAesGcm(plaintext);

    // First 12 bytes should be the nonce
    expect(ciphertext.subarray(0, 12)).toEqual(nonce);

    // Minimum size: 12 (nonce) + 1 (data) + 16 (auth tag) = 29
    expect(ciphertext.length).toBeGreaterThanOrEqual(12 + 1 + 16);
  });

  it("fails to decrypt with wrong key", () => {
    const plaintext = Buffer.from("secret");
    const { ciphertext } = encryptAesGcm(plaintext);
    const wrongKey = Buffer.alloc(16, 0xff);

    expect(() => decryptAesGcm(ciphertext, wrongKey)).toThrow();
  });

  it("handles empty plaintext", () => {
    const plaintext = Buffer.alloc(0);
    const { ciphertext, key } = encryptAesGcm(plaintext);

    const decrypted = decryptAesGcm(ciphertext, key);
    expect(decrypted.length).toBe(0);
  });

  it("handles large plaintext", () => {
    const plaintext = Buffer.alloc(1024 * 100, 0x42); // 100KB
    const { ciphertext, key } = encryptAesGcm(plaintext);

    const decrypted = decryptAesGcm(ciphertext, key);
    expect(decrypted).toEqual(plaintext);
  });
});

describe("key conversion helpers", () => {
  it("converts key to byte array (nMobile wire format)", () => {
    const key = Buffer.from([
      0xb0, 0x71, 0x5a, 0xff, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
      0x0b,
    ]);
    const bytes = keyToByteArray(key);
    expect(bytes).toEqual([176, 113, 90, 255, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("round-trips key through byte array", () => {
    const original = Buffer.from([
      0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
      0x0c,
    ]);
    const bytes = keyToByteArray(original);
    const restored = byteArrayToKey(bytes);
    expect(restored).toEqual(original);
  });

  it("encryption + byte array round-trip", () => {
    const plaintext = Buffer.from("nMobile interop test");
    const { ciphertext, key } = encryptAesGcm(plaintext);

    // Simulate nMobile wire format: convert key to number[] and back
    const keyBytes = keyToByteArray(key);
    const restoredKey = byteArrayToKey(keyBytes);

    const decrypted = decryptAesGcm(ciphertext, restoredKey);
    expect(decrypted.toString()).toBe("nMobile interop test");
  });
});
