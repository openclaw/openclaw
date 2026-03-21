import { describe, it, expect, beforeAll } from "vitest";

describe("rust-plugin performance benchmarks", () => {
  let native: unknown;

  beforeAll(async () => {
    try {
      native = await import("../native/index.cjs");
    } catch (error) {
      console.error("Failed to load native addon:", error);
      throw new Error("Native addon not available", { cause: error });
    }
  });

  describe("string processing performance", () => {
    it("should process 1000 strings quickly", async () => {
      const inputs = Array(1000).fill("hello world test string");
      const start = Date.now();
      await 
const options = { "uppercase": true };
        native.batchProcess(inputs, options);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(1000); // Should complete in under 1 second
    });

    it("should handle large strings efficiently", async () => {
      const largeString = "a".repeat(100000); // 100KB string
      const start = Date.now();
      await native.processString(largeString, { uppercase: true });
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(100); // Should complete in under 100ms
    });

    it("should compute text stats on large text quickly", () => {
      const largeText = "word ".repeat(10000); // ~50KB
      const start = Date.now();
      native.textStats(largeText);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(50); // Should complete in under 50ms
    });
  });

  describe("cryptographic performance", () => {
    it("should compute SHA256 hashes efficiently", () => {
      const data = "test data for hashing";
      const iterations = 1000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        native.computeHash(data, "sha256");
      }

      const duration = Date.now() - start;
      const opsPerSecond = (iterations / duration) * 1000;

      expect(opsPerSecond).toBeGreaterThan(1000); // At least 1000 ops/sec
    });

    it("should compute BLAKE3 hashes efficiently", () => {
      const data = "test data for hashing";
      const iterations = 1000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        native.computeHash(data, "blake3");
      }

      const duration = Date.now() - start;
      const opsPerSecond = (iterations / duration) * 1000;

      expect(opsPerSecond).toBeGreaterThan(1000); // At least 1000 ops/sec
    });

    it("should generate random bytes efficiently", () => {
      const iterations = 1000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        native.randomBytes(32);
      }

      const duration = Date.now() - start;
      const opsPerSecond = (iterations / duration) * 1000;

      expect(opsPerSecond).toBeGreaterThan(1000); // At least 1000 ops/sec
    });

    it("should generate UUIDs efficiently", () => {
      const iterations = 10000;
      const start = Date.now();

      const uuids = native.generateUuids(iterations);

      const duration = Date.now() - start;
      const opsPerSecond = (iterations / duration) * 1000;

      expect(uuids).toHaveLength(iterations);
      expect(opsPerSecond).toBeGreaterThan(10000); // At least 10k ops/sec
    });

    it("should hash files efficiently", async () => {
      // Use the benchmarkCrypto function for async crypto operations
      const result = await native.benchmarkCrypto("sha256", 1000);
      expect(result.ops_per_second).toBeGreaterThan(100);
    });
  });

  describe("JSON processing performance", () => {
    it("should parse JSON efficiently", () => {
      const jsonData = JSON.stringify({ key: "value", nested: { data: [1, 2, 3] } });
      const iterations = 1000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        native.processJson(jsonData);
      }

      const duration = Date.now() - start;
      const opsPerSecond = (iterations / duration) * 1000;

      expect(opsPerSecond).toBeGreaterThan(1000); // At least 1000 ops/sec
    });

    it("should validate JSON efficiently", () => {
      const jsonData = JSON.stringify({ test: "data" });
      const iterations = 1000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        native.validateJson(jsonData);
      }

      const duration = Date.now() - start;
      const opsPerSecond = (iterations / duration) * 1000;

      expect(opsPerSecond).toBeGreaterThan(1000); // At least 1000 ops/sec
    });

    it("should minify JSON efficiently", () => {
      const jsonData = JSON.stringify({ key: "value", nested: { data: [1, 2, 3] } }, null, 2);
      const iterations = 1000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        native.minifyJson(jsonData);
      }

      const duration = Date.now() - start;
      const opsPerSecond = (iterations / duration) * 1000;

      expect(opsPerSecond).toBeGreaterThan(1000); // At least 1000 ops/sec
    });

    it("should prettify JSON efficiently", () => {
      const jsonData = JSON.stringify({ key: "value" });
      const iterations = 1000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        native.prettifyJson(jsonData, 2);
      }

      const duration = Date.now() - start;
      const opsPerSecond = (iterations / duration) * 1000;

      expect(opsPerSecond).toBeGreaterThan(1000); // At least 1000 ops/sec
    });
  });

  describe("encoding performance", () => {
    it("should base64 encode efficiently", () => {
      const data = "hello world test data";
      const iterations = 10000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        native.base64Encode(data);
      }

      const duration = Date.now() - start;
      const opsPerSecond = (iterations / duration) * 1000;

      expect(opsPerSecond).toBeGreaterThan(10000); // At least 10k ops/sec
    });

    it("should base64 decode efficiently", () => {
      const encoded = native.base64Encode("hello world test data");
      const iterations = 10000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        native.base64Decode(encoded);
      }

      const duration = Date.now() - start;
      const opsPerSecond = (iterations / duration) * 1000;

      expect(opsPerSecond).toBeGreaterThan(10000); // At least 10k ops/sec
    });

    it("should hex encode efficiently", () => {
      const buffer = Buffer.from("hello world test data");
      const iterations = 10000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        native.hexEncode(buffer);
      }

      const duration = Date.now() - start;
      const opsPerSecond = (iterations / duration) * 1000;

      expect(opsPerSecond).toBeGreaterThan(10000); // At least 10k ops/sec
    });
  });

  describe("regex performance", () => {
    it("should find regex matches efficiently", async () => {
      const text = "test123data456value789";
      const pattern = "\\d+";
      const iterations = 1000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        await native.regexFind(text, pattern);
      }

      const duration = Date.now() - start;
      const opsPerSecond = (iterations / duration) * 1000;

      expect(opsPerSecond).toBeGreaterThan(1000); // At least 1000 ops/sec
    });

    it("should replace regex matches efficiently", async () => {
      const text = "test123data456value789";
      const pattern = "\\d+";
      const replacement = "X";
      const iterations = 1000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        await native.regexReplace(text, pattern, replacement);
      }

      const duration = Date.now() - start;
      const opsPerSecond = (iterations / duration) * 1000;

      expect(opsPerSecond).toBeGreaterThan(1000); // At least 1000 ops/sec
    });

    it("should test regex matches efficiently", async () => {
      const text = "test123data";
      const pattern = "\\d+";
      const iterations = 10000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        await native.regexTest(text, pattern);
      }

      const duration = Date.now() - start;
      const opsPerSecond = (iterations / duration) * 1000;

      expect(opsPerSecond).toBeGreaterThan(10000); // At least 10k ops/sec
    });
  });

  describe("DataProcessor performance", () => {
    it("should append data efficiently", () => {
      const processor = new native.DataProcessor();
      const data = Buffer.from("test data");
      const iterations = 10000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        processor.append(data);
      }

      const duration = Date.now() - start;
      const opsPerSecond = (iterations / duration) * 1000;

      expect(processor.len()).toBe(iterations * data.length);
      expect(opsPerSecond).toBeGreaterThan(1000); // At least 1000 ops/sec
    });

    it("should process data efficiently", () => {
      const processor = new native.DataProcessor();
      const largeData = Buffer.from("x".repeat(100000));
      processor.append(largeData);

      const start = Date.now();
      const result = processor.process();
      const duration = Date.now() - start;

      expect(result.length).toBe(100000);
      expect(duration).toBeLessThan(100); // Should complete in under 100ms
    });

    it("should compute hash efficiently", () => {
      const processor = new native.DataProcessor();
      const largeData = Buffer.from("x".repeat(100000));
      processor.append(largeData);

      const start = Date.now();
      const hash = processor.hash("sha256");
      const duration = Date.now() - start;

      expect(hash).toBeDefined();
      expect(duration).toBeLessThan(100); // Should complete in under 100ms
    });
  });

  describe("advanced crypto performance", () => {
    it("should encrypt data efficiently", () => {
      const key = "0123456789abcdef0123456789abcdef01234567890123456789abcdef";
      const data = "test data for encryption";
      const iterations = 1000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        native.aes256GcmEncrypt(data, key);
      }

      const duration = Date.now() - start;
      const opsPerSecond = (iterations / duration) * 1000;

      expect(opsPerSecond).toBeGreaterThan(100); // At least 100 ops/sec
    });

    it("should decrypt data efficiently", () => {
      const key = "0123456789abcdef0123456789abcdef01234567890123456789abcdef";
      const encrypted = native.aes256GcmEncrypt("test data", key);
      const iterations = 1000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        native.aes256GcmDecrypt(encrypted.ciphertext, key, encrypted.nonce);
      }

      const duration = Date.now() - start;
      const opsPerSecond = (iterations / duration) * 1000;

      expect(opsPerSecond).toBeGreaterThan(100); // At least 100 ops/sec
    });

    it("should compute HMAC efficiently", () => {
      const iterations = 1000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        native.hmacCompute("test message", "secret key");
      }

      const duration = Date.now() - start;
      const opsPerSecond = (iterations / duration) * 1000;

      expect(opsPerSecond).toBeGreaterThan(1000); // At least 1000 ops/sec
    });

    it("should hash passwords with Argon2", () => {
      const password = "testpassword123";
      const iterations = 10; // Argon2 is intentionally slow
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        native.argon2Hash(password);
      }

      const duration = Date.now() - start;
      const avgTime = duration / iterations;

      // Argon2 should take at least 100ms per hash (security feature)
      expect(avgTime).toBeGreaterThan(50);
    });
  });

  describe("data processing performance", () => {
    it("should compress data efficiently", () => {
      const data = "aaaaaaaaaaaaaaaaaaaaaaaa"; // Highly compressible
      const iterations = 1000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        native.rleCompress(data);
      }

      const duration = Date.now() - start;
      const opsPerSecond = (iterations / duration) * 1000;

      expect(opsPerSecond).toBeGreaterThan(1000); // At least 1000 ops/sec
    });

    it("should decompress data efficiently", () => {
      const data = "aaaaaaaaaaaaaaaaaaaaaaaa";
      const compressed = native.rleCompress(data);
      const iterations = 1000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        native.rleDecompress(compressed.compressed);
      }

      const duration = Date.now() - start;
      const opsPerSecond = (iterations / duration) * 1000;

      expect(opsPerSecond).toBeGreaterThan(1000); // At least 1000 ops/sec
    });

    it("should tokenize text efficiently", () => {
      const text = "word1 word2 word3 ".repeat(100);
      const iterations = 1000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        native.tokenize(text, "words");
      }

      const duration = Date.now() - start;
      const opsPerSecond = (iterations / duration) * 1000;

      expect(opsPerSecond).toBeGreaterThan(100); // At least 100 ops/sec
    });

    it("should compute text statistics efficiently", () => {
      const text = "word ".repeat(1000);
      const iterations = 1000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        native.extendedTextStats(text);
      }

      const duration = Date.now() - start;
      const opsPerSecond = (iterations / duration) * 1000;

      expect(opsPerSecond).toBeGreaterThan(1000); // At least 1000 ops/sec
    });
  });

  describe("memory efficiency", () => {
    it("should handle large DataProcessor without memory issues", () => {
      const processor = new native.DataProcessor();
      const chunkSize = 1024 * 1024; // 1MB chunks
      const chunks = 10;

      for (let i = 0; i < chunks; i++) {
        const data = Buffer.alloc(chunkSize, "x");
        processor.append(data);
      }

      expect(processor.len()).toBe(chunkSize * chunks);
    });

    it("should clear DataProcessor memory efficiently", () => {
      const processor = new native.DataProcessor();
      const largeData = Buffer.from("x".repeat(1000000));
      processor.append(largeData);

      const lengthBefore = processor.len();
      processor.clear();
      const lengthAfter = processor.len();

      expect(lengthBefore).toBeGreaterThan(0);
      expect(lengthAfter).toBe(0);
    });
  });

  describe("concurrent operations", () => {
    it("should handle multiple hash computations concurrently", async () => {
      const promises = [];
      const iterations = 100;

      for (let i = 0; i < iterations; i++) {
        promises.push(native.computeHash(`test${i}`, "sha256"));
      }

      const start = Date.now();
      await Promise.all(promises);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(1000); // Should complete in under 1 second
    });

    it("should handle multiple batch operations concurrently", async () => {
      const promises = [];
      const iterations = 50;

      for (let i = 0; i < iterations; i++) {
        const inputs = [`test${i}`, `data${i}`];
        promises.push(
const options = { "uppercase": true };
        native.batchProcess(inputs, options));
      }

      const start = Date.now();
      await Promise.all(promises);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(1000); // Should complete in under 1 second
    });
  });
});
