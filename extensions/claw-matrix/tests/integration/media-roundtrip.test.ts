/**
 * Integration test: Media Encryption Round-Trip
 *
 * Tests encryptAttachment → decryptAttachment round-trip using the real
 * AES-256-CTR implementation from src/client/media.ts. Since encryptAttachment
 * is not exported, we replicate its logic (matching the existing pattern in
 * tests/media.test.ts) and test against the exported decryptAttachment.
 */

import * as crypto from "node:crypto";
import { describe, it, expect } from "vitest";
import { decryptAttachment, type EncryptedFile } from "../../src/client/media.js";

// ── Replicate encryptAttachment for test fixtures ────────────────────
// (same approach as tests/media.test.ts since encryptAttachment is not exported)

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64url");
}

function toUnpaddedBase64(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "");
}

function testEncryptAttachment(plaintext: Buffer): {
  ciphertext: Buffer;
  file: EncryptedFile;
} {
  const key = crypto.randomBytes(32);
  const ivBytes = Buffer.alloc(16);
  crypto.randomBytes(8).copy(ivBytes, 0);

  const cipher = crypto.createCipheriv("aes-256-ctr", key, ivBytes);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  const hash = crypto.createHash("sha256").update(ciphertext).digest();

  return {
    ciphertext,
    file: {
      url: "mxc://example.com/test-media",
      key: {
        kty: "oct",
        key_ops: ["encrypt", "decrypt"],
        alg: "A256CTR",
        k: toBase64Url(key),
        ext: true,
      },
      iv: toUnpaddedBase64(ivBytes),
      hashes: { sha256: toUnpaddedBase64(hash) },
      v: "v2",
    },
  };
}

describe("Media Encryption Round-Trip", () => {
  describe("encrypt → decrypt correctness", () => {
    it("encrypts a 1024-byte test buffer and ciphertext differs from plaintext", () => {
      const plaintext = Buffer.alloc(1024, 0x42);
      const { ciphertext } = testEncryptAttachment(plaintext);

      // Ciphertext must differ from plaintext (AES-CTR with random key/IV)
      expect(ciphertext).not.toEqual(plaintext);
      // Same length (CTR mode doesn't pad)
      expect(ciphertext.length).toBe(plaintext.length);
    });

    it("decrypts back to the original plaintext", () => {
      const plaintext = Buffer.alloc(1024, 0x42);
      const { ciphertext, file } = testEncryptAttachment(plaintext);

      const decrypted = decryptAttachment(ciphertext, file);

      expect(decrypted).toEqual(plaintext);
    });

    it("round-trips a buffer with mixed byte values", () => {
      const plaintext = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) plaintext[i] = i;

      const { ciphertext, file } = testEncryptAttachment(plaintext);
      const decrypted = decryptAttachment(ciphertext, file);

      expect(decrypted).toEqual(plaintext);
    });

    it("round-trips an empty buffer", () => {
      const plaintext = Buffer.alloc(0);
      const { ciphertext, file } = testEncryptAttachment(plaintext);
      const decrypted = decryptAttachment(ciphertext, file);

      expect(decrypted).toEqual(plaintext);
    });

    it("round-trips a large buffer (64KB)", () => {
      const plaintext = crypto.randomBytes(65_536);
      const { ciphertext, file } = testEncryptAttachment(plaintext);
      const decrypted = decryptAttachment(ciphertext, file);

      expect(decrypted).toEqual(plaintext);
    });
  });

  describe("EncryptedFile metadata structure", () => {
    it("has required key field with correct JWK properties", () => {
      const plaintext = Buffer.alloc(1024, 0x42);
      const { file } = testEncryptAttachment(plaintext);

      expect(file.key.kty).toBe("oct");
      expect(file.key.alg).toBe("A256CTR");
      expect(file.key.ext).toBe(true);
      expect(file.key.key_ops).toEqual(["encrypt", "decrypt"]);
      // k is base64url without padding
      expect(file.key.k).not.toContain("=");
      expect(file.key.k).not.toContain("+");
      expect(file.key.k).not.toContain("/");
    });

    it("has iv field (unpadded base64)", () => {
      const plaintext = Buffer.alloc(1024, 0x42);
      const { file } = testEncryptAttachment(plaintext);

      expect(typeof file.iv).toBe("string");
      expect(file.iv.length).toBeGreaterThan(0);
      expect(file.iv).not.toContain("=");
    });

    it("has hashes.sha256 field (unpadded base64)", () => {
      const plaintext = Buffer.alloc(1024, 0x42);
      const { file } = testEncryptAttachment(plaintext);

      expect(typeof file.hashes.sha256).toBe("string");
      expect(file.hashes.sha256.length).toBeGreaterThan(0);
      // SHA-256 produces 32 bytes → 43 base64 chars (unpadded)
      expect(file.hashes.sha256).not.toContain("=");
    });

    it("has url and version fields", () => {
      const plaintext = Buffer.alloc(1024, 0x42);
      const { file } = testEncryptAttachment(plaintext);

      expect(file.url).toBe("mxc://example.com/test-media");
      expect(file.v).toBe("v2");
    });
  });

  describe("SHA-256 hash validation", () => {
    it("rejects tampered ciphertext (single byte flip)", () => {
      const plaintext = Buffer.alloc(1024, 0x42);
      const { ciphertext, file } = testEncryptAttachment(plaintext);

      // Flip one byte in the ciphertext
      const tampered = Buffer.from(ciphertext);
      tampered[0] ^= 0xff;

      expect(() => decryptAttachment(tampered, file)).toThrow(/hash mismatch/);
    });

    it("rejects completely replaced ciphertext", () => {
      const plaintext = Buffer.alloc(1024, 0x42);
      const { file } = testEncryptAttachment(plaintext);

      // Generate completely different ciphertext
      const fakeCiphertext = crypto.randomBytes(1024);

      expect(() => decryptAttachment(fakeCiphertext, file)).toThrow(/hash mismatch/);
    });

    it("rejects truncated ciphertext", () => {
      const plaintext = Buffer.alloc(1024, 0x42);
      const { ciphertext, file } = testEncryptAttachment(plaintext);

      // Truncate to half
      const truncated = ciphertext.subarray(0, 512);

      expect(() => decryptAttachment(truncated, file)).toThrow(/hash mismatch/);
    });

    it("rejects when hash in metadata is wrong", () => {
      const plaintext = Buffer.alloc(1024, 0x42);
      const { ciphertext, file } = testEncryptAttachment(plaintext);

      // Replace hash with a random one
      const badFile: EncryptedFile = {
        ...file,
        hashes: { sha256: toUnpaddedBase64(crypto.randomBytes(32)) },
      };

      expect(() => decryptAttachment(ciphertext, badFile)).toThrow(/hash mismatch/);
    });
  });

  describe("Algorithm validation", () => {
    it("rejects unsupported algorithm", () => {
      const plaintext = Buffer.alloc(1024, 0x42);
      const { ciphertext, file } = testEncryptAttachment(plaintext);

      const badFile: EncryptedFile = {
        ...file,
        key: { ...file.key, alg: "A128CTR" as any },
      };

      expect(() => decryptAttachment(ciphertext, badFile)).toThrow(
        /Unsupported encryption algorithm/,
      );
    });
  });

  describe("Encryption randomness", () => {
    it("same plaintext produces different ciphertext on each call", () => {
      const plaintext = Buffer.alloc(1024, 0x42);
      const { ciphertext: ct1 } = testEncryptAttachment(plaintext);
      const { ciphertext: ct2 } = testEncryptAttachment(plaintext);

      // Different random key + IV → different ciphertext
      expect(ct1).not.toEqual(ct2);
    });

    it("same plaintext produces different keys on each call", () => {
      const plaintext = Buffer.alloc(1024, 0x42);
      const { file: f1 } = testEncryptAttachment(plaintext);
      const { file: f2 } = testEncryptAttachment(plaintext);

      expect(f1.key.k).not.toBe(f2.key.k);
    });

    it("same plaintext produces different IVs on each call", () => {
      const plaintext = Buffer.alloc(1024, 0x42);
      const { file: f1 } = testEncryptAttachment(plaintext);
      const { file: f2 } = testEncryptAttachment(plaintext);

      expect(f1.iv).not.toBe(f2.iv);
    });
  });
});
