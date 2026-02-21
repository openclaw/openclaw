import { describe, it, expect } from "vitest";
import {
  encryptPrivateKey,
  decryptPrivateKey,
  deriveKeyFromPassphrase,
  isValidEncryptedPrivateKey,
  type EncryptedPrivateKey,
} from "./crypto-util.js";

describe("crypto-util", () => {
  // Test private keys (test vectors)
  const TEST_PRIVATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const TEST_PASSPHRASE = "super-secret-passphrase";
  const TEST_PASSPHRASE_2 = "different-passphrase";

  describe("deriveKeyFromPassphrase", () => {
    it("should derive a 32-byte key from a passphrase", () => {
      const [derivedKey, salt] = deriveKeyFromPassphrase(TEST_PASSPHRASE);
      expect(derivedKey).toBeInstanceOf(Buffer);
      expect(derivedKey.length).toBe(32);
      expect(salt).toBeInstanceOf(Buffer);
      expect(salt.length).toBe(32);
    });

    it("should derive consistent keys with same salt", () => {
      const salt = Buffer.from(
        "0000000000000000000000000000000000000000000000000000000000000000",
        "hex",
      );
      const [key1] = deriveKeyFromPassphrase(TEST_PASSPHRASE, salt);
      const [key2] = deriveKeyFromPassphrase(TEST_PASSPHRASE, salt);
      expect(key1).toEqual(key2);
    });

    it("should produce different keys for different passphrases", () => {
      const salt = Buffer.alloc(32);
      const [key1] = deriveKeyFromPassphrase(TEST_PASSPHRASE, salt);
      const [key2] = deriveKeyFromPassphrase(TEST_PASSPHRASE_2, salt);
      expect(key1).not.toEqual(key2);
    });
  });

  describe("encryptPrivateKey", () => {
    it("should encrypt a valid private key", () => {
      const encrypted = encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE);

      expect(encrypted).toHaveProperty("algorithm");
      expect(encrypted).toHaveProperty("iv");
      expect(encrypted).toHaveProperty("authTag");
      expect(encrypted).toHaveProperty("ciphertext");
      expect(encrypted).toHaveProperty("salt");

      expect(encrypted.algorithm).toBe("aes-256-gcm");
      expect(typeof encrypted.iv).toBe("string");
      expect(typeof encrypted.authTag).toBe("string");
      expect(typeof encrypted.ciphertext).toBe("string");
      expect(typeof encrypted.salt).toBe("string");
    });

    it("should reject invalid private key format", () => {
      expect(() => encryptPrivateKey("invalid", TEST_PASSPHRASE)).toThrow(
        "Private key must be 64 hex characters",
      );

      expect(() => encryptPrivateKey("00", TEST_PASSPHRASE)).toThrow(
        "Private key must be 64 hex characters",
      );
    });

    it("should produce different ciphertexts for same key (due to random IV)", () => {
      const encrypted1 = encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE);
      const encrypted2 = encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE);

      // Different IVs should produce different ciphertexts
      expect(encrypted1.iv).not.toBe(encrypted2.iv);
      expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
      expect(encrypted1.salt).not.toBe(encrypted2.salt);
    });
  });

  describe("decryptPrivateKey", () => {
    it("should decrypt encrypted private key correctly", () => {
      const encrypted = encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE);
      const decrypted = decryptPrivateKey(encrypted, TEST_PASSPHRASE);
      expect(decrypted).toBe(TEST_PRIVATE_KEY);
    });

    it("should handle case-insensitive hex input", () => {
      const upperKey = TEST_PRIVATE_KEY.toUpperCase();
      const encrypted = encryptPrivateKey(upperKey, TEST_PASSPHRASE);
      const decrypted = decryptPrivateKey(encrypted, TEST_PASSPHRASE);
      // The decrypted value will be in original case, so compare normalized
      expect(decrypted.toLowerCase()).toBe(TEST_PRIVATE_KEY.toLowerCase());
    });

    it("should fail with wrong passphrase", () => {
      const encrypted = encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE);
      expect(() => decryptPrivateKey(encrypted, TEST_PASSPHRASE_2)).toThrow();
    });

    it("should fail with tampered ciphertext", () => {
      const encrypted = encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE);
      const tampered: EncryptedPrivateKey = {
        ...encrypted,
        ciphertext: Buffer.from(Buffer.from(encrypted.ciphertext, "base64")).toString("base64"),
      };

      // Change one byte in the ciphertext
      const buf = Buffer.from(tampered.ciphertext, "base64");
      buf[0] ^= 0xff; // Flip bits
      tampered.ciphertext = buf.toString("base64");

      expect(() => decryptPrivateKey(tampered, TEST_PASSPHRASE)).toThrow();
    });

    it("should fail with tampered auth tag", () => {
      const encrypted = encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE);
      const tampered: EncryptedPrivateKey = {
        ...encrypted,
        authTag: Buffer.from(Buffer.from(encrypted.authTag, "base64")).toString("base64"),
      };

      // Flip bits in auth tag
      const buf = Buffer.from(tampered.authTag, "base64");
      buf[0] ^= 0x01;
      tampered.authTag = buf.toString("base64");

      expect(() => decryptPrivateKey(tampered, TEST_PASSPHRASE)).toThrow();
    });

    it("should reject unsupported algorithm", () => {
      const encrypted: EncryptedPrivateKey = {
        algorithm: "aes-256-gcm",
        iv: "test",
        authTag: "test",
        ciphertext: "test",
        salt: "test",
      };

      // Manually set to unsupported algorithm
      (encrypted as unknown as Record<string, unknown>).algorithm = "unknown";

      expect(() => decryptPrivateKey(encrypted, TEST_PASSPHRASE)).toThrow(
        "Unsupported encryption algorithm",
      );
    });
  });

  describe("roundtrip encryption/decryption", () => {
    it("should support roundtrip with various passphrases", () => {
      const passphrases = [
        "simple",
        "with spaces",
        "with-dashes",
        "with_underscores",
        "with.dots",
        "withNumbers123",
        "withSpecial!@#$%^&*()",
        "emoji-🔐🔑",
      ];

      for (const passphrase of passphrases) {
        const encrypted = encryptPrivateKey(TEST_PRIVATE_KEY, passphrase);
        const decrypted = decryptPrivateKey(encrypted, passphrase);
        expect(decrypted).toBe(TEST_PRIVATE_KEY);
      }
    });

    it("should support roundtrip with various valid private keys", () => {
      const keys = [
        "0000000000000000000000000000000000000000000000000000000000000000",
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        "1111111111111111111111111111111111111111111111111111111111111111",
      ];

      for (const key of keys) {
        const encrypted = encryptPrivateKey(key, TEST_PASSPHRASE);
        const decrypted = decryptPrivateKey(encrypted, TEST_PASSPHRASE);
        expect(decrypted).toBe(key);
      }
    });
  });

  describe("isValidEncryptedPrivateKey", () => {
    it("should recognize valid encrypted private key objects", () => {
      const encrypted = encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE);
      expect(isValidEncryptedPrivateKey(encrypted)).toBe(true);
    });

    it("should reject invalid objects", () => {
      expect(isValidEncryptedPrivateKey(null)).toBe(false);
      expect(isValidEncryptedPrivateKey(undefined)).toBe(false);
      expect(isValidEncryptedPrivateKey({})).toBe(false);
      expect(isValidEncryptedPrivateKey({ algorithm: "aes-256-gcm" })).toBe(false);
      expect(isValidEncryptedPrivateKey("not an object")).toBe(false);
      expect(isValidEncryptedPrivateKey(123)).toBe(false);
    });

    it("should require all fields", () => {
      const encrypted = encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE);

      // Missing algorithm
      expect(
        isValidEncryptedPrivateKey({
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          ciphertext: encrypted.ciphertext,
          salt: encrypted.salt,
        }),
      ).toBe(false);

      // Missing iv
      expect(
        isValidEncryptedPrivateKey({
          algorithm: "aes-256-gcm",
          authTag: encrypted.authTag,
          ciphertext: encrypted.ciphertext,
          salt: encrypted.salt,
        }),
      ).toBe(false);

      // Wrong type for field
      expect(
        isValidEncryptedPrivateKey({
          algorithm: "aes-256-gcm",
          iv: 123, // Should be string
          authTag: encrypted.authTag,
          ciphertext: encrypted.ciphertext,
          salt: encrypted.salt,
        }),
      ).toBe(false);
    });

    it("should validate algorithm value", () => {
      const encrypted = encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE);
      expect(
        isValidEncryptedPrivateKey({
          algorithm: "aes-256-cbc", // Wrong algorithm
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          ciphertext: encrypted.ciphertext,
          salt: encrypted.salt,
        }),
      ).toBe(false);
    });
  });
});
