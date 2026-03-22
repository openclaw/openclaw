import { describe, it, expect, beforeAll } from "vitest";

describe("rust-plugin advanced cryptography", () => {
  let native: unknown;

  beforeAll(async () => {
    try {
      native = await import("../native/index.cjs");
    } catch (error) {
      console.error("Failed to load native addon:", error);
      throw new Error("Native addon not available", { cause: error });
    }
  });

  describe("encryption", () => {
    describe("aes256_gcm_encrypt", () => {
      it("should encrypt with valid 32-byte key", () => {
        const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // 32 bytes = 64 hex chars
        const result = native.aes256GcmEncrypt("hello world", key);

        expect(result.ciphertext).toBeDefined();
        expect(result.nonce).toBeDefined();
        expect(result.ciphertext).toMatch(/^[a-f0-9]+$/);
        expect(result.nonce).toMatch(/^[a-f0-9]+$/);
      });

      it("should generate random nonce if not provided", () => {
        const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const result1 = native.aes256GcmEncrypt("test", key);
        const result2 = native.aes256GcmEncrypt("test", key);

        expect(result1.nonce).not.toBe(result2.nonce);
      });

      it("should use provided nonce", () => {
        const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const nonce = "0123456789abcdef0123456789"; // 24 hex characters
        const result = native.aes256GcmEncrypt("test", key, nonce);

        expect(result.nonce).toBe(nonce);
      });

      it("should throw error for invalid key length", () => {
        const shortKey = "short";
        expect(() => native.aes256GcmEncrypt("test", shortKey)).toThrow();
      });

      it("should throw error for invalid nonce format", () => {
        const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        expect(() => native.aes256GcmEncrypt("test", key, "invalid")).toThrow();
      });

      it("should handle empty string", () => {
        const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const result = native.aes256GcmEncrypt("", key);
        expect(result.ciphertext).toBeDefined();
      });

      it("should handle unicode characters", () => {
        const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const result = native.aes256GcmEncrypt("你好世界", key);
        expect(result.ciphertext).toBeDefined();
      });
    });

    describe("aes256_gcm_decrypt", () => {
      it("should decrypt correctly", () => {
        const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const encrypted = native.aes256GcmEncrypt("hello world", key);
        const decrypted = native.aes256GcmDecrypt(encrypted.ciphertext, key, encrypted.nonce);

        expect(decrypted.success).toBe(true);
        expect(decrypted.plaintext).toBe("hello world");
        expect(decrypted.error).toBeNull();
      });

      it("should throw error for invalid key length", () => {
        const shortKey = "short";
        expect(() => native.aes256GcmDecrypt("ciphertext", shortKey, "nonce")).toThrow();
      });

      it("should throw error for invalid ciphertext format", () => {
        const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        expect(() => native.aes256GcmDecrypt("invalid hex", key, "nonce")).toThrow();
      });

      it("should handle empty string", () => {
        const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const encrypted = native.aes256GcmEncrypt("", key);
        const decrypted = native.aes256GcmDecrypt(encrypted.ciphertext, key, encrypted.nonce);
        expect(decrypted.plaintext).toBe("");
      });

      it("should handle unicode characters", () => {
        const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const encrypted = native.aes256GcmEncrypt("你好世界", key);
        const decrypted = native.aes256GcmDecrypt(encrypted.ciphertext, key, encrypted.nonce);
        expect(decrypted.plaintext).toBe("你好世界");
      });
    });

    describe("encryption/decryption roundtrip", () => {
      it("should maintain data integrity through roundtrip", () => {
        const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const original = "The quick brown fox jumps over the lazy dog";

        const encrypted = native.aes256GcmEncrypt(original, key);
        const decrypted = native.aes256GcmDecrypt(encrypted.ciphertext, key, encrypted.nonce);

        expect(decrypted.plaintext).toBe(original);
      });

      it("should handle multiple encryptions with same key", () => {
        const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        const encrypted1 = native.aes256GcmEncrypt("message1", key);
        const encrypted2 = native.aes256GcmEncrypt("message2", key);

        expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);

        const decrypted1 = native.aes256GcmDecrypt(encrypted1.ciphertext, key, encrypted1.nonce);
        const decrypted2 = native.aes256GcmDecrypt(encrypted2.ciphertext, key, encrypted2.nonce);

        expect(decrypted1.plaintext).toBe("message1");
        expect(decrypted2.plaintext).toBe("message2");
      });
    });
  });

  describe("hashing", () => {
    describe("sha256_hash", () => {
      it("should compute SHA256 hash", () => {
        const hash = native.sha256Hash("hello");
        expect(hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
      });

      it("should compute SHA256 with salt", () => {
        const hash1 = native.sha256Hash("password", "salt1");
        const hash2 = native.sha256Hash("password", "salt2");
        expect(hash1).not.toBe(hash2);
      });

      it("should produce consistent hashes", () => {
        const hash1 = native.sha256Hash("test", "salt");
        const hash2 = native.sha256Hash("test", "salt");
        expect(hash1).toBe(hash2);
      });

      it("should handle empty string", () => {
        const hash = native.sha256Hash("");
        expect(hash).toBeDefined();
        expect(hash).toHaveLength(64);
      });
    });

    describe("blake3_hash_keyed", () => {
      it("should compute BLAKE3 hash", () => {
        const hash = native.blake3HashKeyed("hello");
        expect(hash).toHaveLength(64);
        expect(hash).toMatch(/^[a-f0-9]+$/);
      });

      it("should compute keyed BLAKE3 hash", () => {
        const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // 32 bytes
        const hash = native.blake3HashKeyed("hello", key);
        expect(hash).toHaveLength(64);
      });

      it("should produce different hashes with different keys", () => {
        const key1 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const key2 =
          "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
        const hash1 = native.blake3HashKeyed("test", key1);
        const hash2 = native.blake3HashKeyed("test", key2);
        expect(hash1).not.toBe(hash2);
      });

      it("should handle short keys", () => {
        const shortKey = "short";
        const hash = native.blake3HashKeyed("test", shortKey);
        expect(hash).toHaveLength(64);
      });
    });

    describe("batch_hash", () => {
      it("should hash multiple inputs with SHA256", () => {
        const inputs = ["hello", "world", "test"];
        const hashes = native.batchHash(inputs, "sha256");
        expect(hashes).toHaveLength(3);
        hashes.forEach((hash: string) => {
          expect(hash).toHaveLength(64);
        });
      });

      it("should hash multiple inputs with BLAKE3", () => {
        const inputs = ["hello", "world", "test"];
        const hashes = native.batchHash(inputs, "blake3");
        expect(hashes).toHaveLength(3);
        hashes.forEach((hash: string) => {
          expect(hash).toHaveLength(64);
        });
      });

      it("should handle empty array", () => {
        const hashes = native.batchHash([], "sha256");
        expect(hashes).toEqual([]);
      });

      it("should throw error for unsupported algorithm", () => {
        expect(() => native.batchHash(["test"], "md5")).toThrow();
      });
    });
  });

  describe("random generation", () => {
    describe("secure_random", () => {
      it("should generate random bytes as hex", () => {
        const random = native.secureRandom(16);
        expect(random).toHaveLength(32); // 16 bytes = 32 hex chars
        expect(random).toMatch(/^[a-f0-9]+$/);
      });

      it("should generate different values each time", () => {
        const random1 = native.secureRandom(16);
        const random2 = native.secureRandom(16);
        expect(random1).not.toBe(random2);
      });

      it("should handle zero length", () => {
        const random = native.secureRandom(0);
        expect(random).toBe("");
      });

      it("should handle large lengths", () => {
        const random = native.secureRandom(1024);
        expect(random).toHaveLength(2048); // 1024 bytes = 2048 hex chars
      });
    });
  });

  describe("password hashing", () => {
    describe("argon2_hash", () => {
      it("should hash password with Argon2", () => {
        const hash = native.argon2Hash("password123");
        expect(hash).toBeDefined();
        expect(hash).toContain("$argon2");
      });

      it("should generate different hashes for same password", () => {
        const hash1 = native.argon2Hash("password");
        const hash2 = native.argon2Hash("password");
        expect(hash1).not.toBe(hash2); // Different salts
      });

      it("should hash with custom salt", () => {
        const salt = "customsalt";
        const hash = native.argon2Hash("password", salt);
        expect(hash).toBeDefined();
        expect(hash).toContain("$argon2");
      });

      it("should throw error for invalid salt", () => {
        // Salt that's too long or invalid format
        expect(() => native.argon2Hash("password", "x".repeat(1000))).toThrow();
      });

      it("should handle empty password", () => {
        const hash = native.argon2Hash("");
        expect(hash).toBeDefined();
      });
    });

    describe("argon2_verify", () => {
      it("should verify correct password", () => {
        const password = "mypassword";
        const hash = native.argon2Hash(password);
        const isValid = native.argon2Verify(password, hash);
        expect(isValid).toBe(true);
      });

      it("should reject incorrect password", () => {
        const hash = native.argon2Hash("correctpassword");
        const isValid = native.argon2Verify("wrongpassword", hash);
        expect(isValid).toBe(false);
      });

      it("should throw error for invalid hash format", () => {
        expect(() => native.argon2Verify("password", "invalid")).toThrow();
      });

      it("should handle empty password", () => {
        const hash = native.argon2Hash("");
        const isValid = native.argon2Verify("", hash);
        expect(isValid).toBe(true);
      });
    });
  });

  describe("HMAC", () => {
    describe("hmac_compute", () => {
      it("should compute HMAC-SHA256", () => {
        const hmac = native.hmacCompute("message", "secretkey");
        expect(hmac).toHaveLength(64); // 256 bits = 64 hex chars
        expect(hmac).toMatch(/^[a-f0-9]+$/);
      });

      it("should produce consistent HMACs", () => {
        const hmac1 = native.hmacCompute("test", "key");
        const hmac2 = native.hmacCompute("test", "key");
        expect(hmac1).toBe(hmac2);
      });

      it("should produce different HMACs with different keys", () => {
        const hmac1 = native.hmacCompute("test", "key1");
        const hmac2 = native.hmacCompute("test", "key2");
        expect(hmac1).not.toBe(hmac2);
      });

      it("should throw error for unsupported algorithm", () => {
        expect(() => native.hmacCompute("test", "key", "md5")).toThrow();
      });

      it("should handle empty message", () => {
        const hmac = native.hmacCompute("", "key");
        expect(hmac).toBeDefined();
      });

      it("should handle empty key", () => {
        const hmac = native.hmacCompute("message", "");
        expect(hmac).toBeDefined();
      });
    });
  });

  describe("key derivation", () => {
    describe("hkdf_derive", () => {
      it("should derive key using HKDF", () => {
        const ikm = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // Input key material
        const salt =
          "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
        const info = "context";
        const derived = native.hkdfDerive(ikm, salt, info, 32);

        expect(derived).toHaveLength(64); // 32 bytes = 64 hex chars
        expect(derived).toMatch(/^[a-f0-9]+$/);
      });

      it("should derive different keys with different salts", () => {
        const ikm = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const derived1 = native.hkdfDerive(ikm, "salt1", "info", 32);
        const derived2 = native.hkdfDerive(ikm, "salt2", "info", 32);
        expect(derived1).not.toBe(derived2);
      });

      it("should derive different keys with different info", () => {
        const ikm = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const salt =
          "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
        const derived1 = native.hkdfDerive(ikm, salt, "info1", 32);
        const derived2 = native.hkdfDerive(ikm, salt, "info2", 32);
        expect(derived1).not.toBe(derived2);
      });

      it("should use default length if not specified", () => {
        const ikm = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const salt =
          "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
        const derived = native.hkdfDerive(ikm, salt, "info");
        expect(derived).toHaveLength(64); // Default 32 bytes
      });

      it("should throw error for invalid salt format", () => {
        const ikm = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        expect(() => native.hkdfDerive(ikm, "invalid hex", "info", 32)).toThrow();
      });

      it("should handle custom length", () => {
        const ikm = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const salt =
          "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
        const derived16 = native.hkdfDerive(ikm, salt, "info", 16);
        const derived64 = native.hkdfDerive(ikm, salt, "info", 64);
        expect(derived16).toHaveLength(32);
        expect(derived64).toHaveLength(128);
      });
    });
  });

  describe("crypto benchmarks", () => {
    describe("benchmark_crypto", () => {
      it("should benchmark SHA256", async () => {
        const result = await native.benchmarkCrypto("sha256", 1000);
        expect(result.operation).toBe("sha256");
        expect(result.iterations).toBe(1000);
        expect(result.durationMs).toBeGreaterThan(0);
        expect(result.opsPerSecond).toBeGreaterThan(0);
      });

      it("should benchmark BLAKE3", async () => {
        const result = await native.benchmarkCrypto("blake3", 1000);
        expect(result.operation).toBe("blake3");
        expect(result.iterations).toBe(1000);
        expect(result.durationMs).toBeGreaterThan(0);
        expect(result.opsPerSecond).toBeGreaterThan(0);
      });

      it("should use default iterations", async () => {
        const result = await native.benchmarkCrypto("sha256");
        expect(result.iterations).toBe(1000); // Default
      });

      it("should throw error for unknown operation", async () => {
        await expect(native.benchmarkCrypto("unknown")).rejects.toThrow();
      });

      it("should provide consistent performance metrics", async () => {
        const result1 = await native.benchmarkCrypto("sha256", 100);
        const result2 = await native.benchmarkCrypto("sha256", 100);

        // Results should be in similar range (within 10x)
        const ratio = result1.durationMs / result2.durationMs;
        expect(ratio).toBeGreaterThan(0.1);
        expect(ratio).toBeLessThan(10);
      });
    });
  });

  describe("webhook handling", () => {
    describe("handle_webhook", () => {
      it("should handle valid JSON webhook", async () => {
        const body = JSON.stringify({ event: "test", data: "value" });
        const result = await native.handleWebhook(body);

        expect(result.statusCode).toBe(200);
        expect(result.processed).toBe(true);
        expect(result.body).toContain("received");
        expect(result.body).toContain("timestamp");
      });

      it("should reject invalid JSON webhook", async () => {
        const body = "not valid json";
        const result = await native.handleWebhook(body);

        expect(result.statusCode).toBe(400);
        expect(result.processed).toBe(false);
        expect(result.body).toContain("error");
      });

      it("should handle empty JSON object", async () => {
        const body = "{}";
        const result = await native.handleWebhook(body);

        expect(result.statusCode).toBe(200);
        expect(result.processed).toBe(true);
      });

      it("should handle complex JSON", async () => {
        const body = JSON.stringify({
          nested: { data: { values: [1, 2, 3] } },
          timestamp: Date.now(),
        });
        const result = await native.handleWebhook(body);

        expect(result.statusCode).toBe(200);
        expect(result.processed).toBe(true);
      });
    });
  });
});
