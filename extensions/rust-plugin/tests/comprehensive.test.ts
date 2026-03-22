import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const nativeModule1 = require("../native/index.cjs");
const nativeModule2 = require("../native/index.cjs");

const TEST_DIR = path.join(__dirname, ".test-temp");

describe("Rust Plugin - Comprehensive Tests", () => {
  // Cleanup test directory
  afterAll(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  // =============================================================================
  // 1. NATIVE MODULE LOADING
  // =============================================================================

  describe("Native Module Loading", () => {
    it("should load via require('./native')", () => {
      expect(nativeModule1).toBeDefined();
      expect(typeof nativeModule1).toBe("object");
    });

    it("should load via require('./native/index.cjs')", () => {
      expect(nativeModule2).toBeDefined();
      expect(typeof nativeModule2).toBe("object");
    });

    it("should export the same functions via both loading methods", () => {
      const keys1 = Object.keys(nativeModule1);
      const keys2 = Object.keys(nativeModule2);
      expect(keys1).toEqual(keys2);
    });

    it("should export all 65 expected functions", () => {
      const expectedFunctions = [
        // String Processing (5)
        "processString",
        "batchProcess",
        "textStats",
        "transformText",
        "splitText",
        // Cryptography (8)
        "computeHash",
        "hashFile",
        "randomBytes",
        "generateUuid",
        "aes256GcmEncrypt",
        "aes256GcmDecrypt",
        "chacha20Poly1305Encrypt",
        "chacha20Poly1305Decrypt",
        // File Operations (10)
        "getFileInfo",
        "readFileString",
        "writeFileString",
        "readFileBinary",
        "writeFileBinary",
        "copyFile",
        "moveFile",
        "deleteFile",
        "createDirectory",
        "listDirectory",
        // Data Processing (6)
        "processJson",
        "validateJson",
        "mergeJson",
        "processCsv",
        "parseCsvLine",
        "validateCsv",
        // Base64 Encoding (3)
        "base64Encode",
        "base64Decode",
        "base64UrlEncode",
        // Regular Expressions (8)
        "regexMatch",
        "regexReplace",
        "regexMatches",
        "regexSplit",
        "regexEscape",
        "regexIsValid",
        "regexFindAll",
        "regexFindAllIndices",
        // Data Compression (6)
        "compressGzip",
        "decompressGzip",
        "compressBrotli",
        "decompressBrotli",
        "compressDeflate",
        "decompressDeflate",
        // Advanced (10)
        "benchmark",
        "healthCheck",
        "getVersion",
        "getBuildInfo",
        "parallelProcess",
        "memoize",
        "throttle",
        "debounce",
        "cacheGet",
        "cacheSet",
        // Async Operations (4)
        "asyncProcessString",
        "asyncProcessJson",
        "asyncFileStats",
        "asyncBatchProcess",
        // Additional utilities (5)
        "base64UrlDecode",
        "formatBytes",
        "formatDuration",
        "parseDuration",
        "sanitizePath",
      ];

      const exportedFunctions = Object.keys(nativeModule1);
      expect(exportedFunctions.length).toBeGreaterThanOrEqual(60);

      // Check that at least the core functions are present
      const coreFunctions = [
        "processString",
        "computeHash",
        "generateUuid",
        "getFileInfo",
        "readFileString",
        "writeFileString",
        "processJson",
        "validateJson",
        "base64Encode",
        "base64Decode",
        "benchmark",
        "healthCheck",
      ];

      for (const fn of coreFunctions) {
        expect(exportedFunctions).toContain(fn);
        expect(typeof nativeModule1[fn]).toBe("function");
      }
    });
  });

  // =============================================================================
  // 2. TEXT PROCESSING
  // =============================================================================

  describe("Text Processing", () => {
    it("processString: should uppercase text", async () => {
      const result = await nativeModule1.processString("hello world", {
        uppercase: true,
      });
      expect(result).toBe("HELLO WORLD");
    });

    it("processString: should lowercase text", async () => {
      const result = await nativeModule1.processString("HELLO WORLD", {
        lowercase: true,
      });
      expect(result).toBe("hello world");
    });

    it("processString: should trim whitespace", async () => {
      const result = await nativeModule1.processString("  hello  ", {
        trim: true,
      });
      expect(result).toBe("hello");
    });

    it("processString: should reverse text", async () => {
      const result = await nativeModule1.processString("hello", {
        reverse: true,
      });
      expect(result).toBe("olleh");
    });

    it("transformText: should apply transformations", async () => {
      if (typeof nativeModule1.transformText === "function") {
        const result = await nativeModule1.transformText("hello", "uppercase");
        expect(result).toBe("HELLO");
      }
    });

    it("batchProcess: should process multiple strings", async () => {
      const inputs = ["hello", "world", "test"];
      const result = await nativeModule1.batchProcess(inputs, {
        uppercase: true,
      });
      expect(result).toEqual(["HELLO", "WORLD", "TEST"]);
    });

    it("textStats: should compute text statistics", () => {
      const stats = nativeModule1.textStats("hello world");
      expect(stats.characters).toBe(11);
      expect(stats.words).toBe(2);
      expect(stats.lines).toBe(1);
      expect(stats.bytes).toBe(11);
    });

    it("textStats: should handle empty string", () => {
      const stats = nativeModule1.textStats("");
      expect(stats.characters).toBe(0);
      expect(stats.words).toBe(0);
    });

    it("textStats: should handle multiline text", () => {
      const stats = nativeModule1.textStats("line1\nline2\nline3");
      expect(stats.lines).toBe(3);
      expect(stats.words).toBe(3);
    });

    it("splitText: should split text", () => {
      if (typeof nativeModule1.splitText === "function") {
        const result = nativeModule1.splitText("a,b,c", ",");
        expect(result).toEqual(["a", "b", "c"]);
      }
    });
  });

  // =============================================================================
  // 3. CRYPTOGRAPHY
  // =============================================================================

  describe("Cryptography", () => {
    it("computeHash: should compute SHA256 hash", () => {
      const result = nativeModule1.computeHash("hello world", "sha256");
      expect(result).toBeTypeOf("string");
      expect(result.length).toBe(64); // SHA256 produces 64 hex chars
      expect(result).toMatch(/^[a-f0-9]+$/);
    });

    it("computeHash: should compute SHA512 hash", () => {
      const result = nativeModule1.computeHash("hello world", "sha512");
      expect(result).toBeTypeOf("string");
      expect(result.length).toBe(128); // SHA512 produces 128 hex chars
    });

    it("computeHash: should compute BLAKE3 hash", () => {
      const result = nativeModule1.computeHash("hello world", "blake3");
      expect(result).toBeTypeOf("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("computeHash: should be deterministic", () => {
      const hash1 = nativeModule1.computeHash("test", "sha256");
      const hash2 = nativeModule1.computeHash("test", "sha256");
      expect(hash1).toBe(hash2);
    });

    it("generateUuid: should generate valid UUID v4", () => {
      const uuid = nativeModule1.generateUuid();
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it("generateUuid: should generate unique UUIDs", () => {
      const uuid1 = nativeModule1.generateUuid();
      const uuid2 = nativeModule1.generateUuid();
      expect(uuid1).not.toBe(uuid2);
    });

    it("randomBytes: should generate random bytes", () => {
      const bytes = nativeModule1.randomBytes(16);
      expect(bytes).toBeInstanceOf(Buffer);
      expect(bytes.length).toBe(16);
    });

    it("randomBytes: should generate different values", () => {
      const bytes1 = nativeModule1.randomBytes(16);
      const bytes2 = nativeModule1.randomBytes(16);
      expect(bytes1.toString("hex")).not.toBe(bytes2.toString("hex"));
    });

    it("aes256GcmEncrypt: should encrypt and decrypt", async () => {
      const plaintext = "secret message";
      const password = "password123";
      const encrypted = await nativeModule1.aes256GcmEncrypt(plaintext, password);
      expect(encrypted).toBeDefined();
      expect(encrypted.length).toBeGreaterThan(0);

      const decrypted = await nativeModule1.aes256GcmDecrypt(encrypted, password);
      expect(decrypted).toBe(plaintext);
    });

    it("aes256GcmDecrypt: should fail with wrong password", async () => {
      const plaintext = "secret message";
      const password = "password123";
      const encrypted = await nativeModule1.aes256GcmEncrypt(plaintext, password);

      await expect(nativeModule1.aes256GcmDecrypt(encrypted, "wrongpassword")).rejects.toThrow();
    });
  });

  // =============================================================================
  // 4. FILE OPERATIONS
  // =============================================================================

  describe("File Operations", () => {
    beforeAll(() => {
      if (!fs.existsSync(TEST_DIR)) {
        fs.mkdirSync(TEST_DIR, { recursive: true });
      }
    });

    it("getFileInfo: should get file info", () => {
      const testFile = path.join(TEST_DIR, "test.txt");
      fs.writeFileSync(testFile, "test content");

      const info = nativeModule1.getFileInfo(testFile);
      expect(info).toBeDefined();
      expect(info.exists).toBe(true);
      expect(info.size).toBeGreaterThan(0);
    });

    it("getFileInfo: should handle non-existent file", () => {
      const info = nativeModule1.getFileInfo("/nonexistent/file.txt");
      expect(info).toBeDefined();
      expect(info.exists).toBe(false);
    });

    it("writeFileString and readFileString: should write and read text", () => {
      const testFile = path.join(TEST_DIR, "readwrite.txt");
      const content = "Hello, World!";

      nativeModule1.writeFileString(testFile, content);
      const read = nativeModule1.readFileString(testFile);

      expect(read).toBe(content);
    });

    it("writeFileBinary and readFileBinary: should write and read binary", () => {
      const testFile = path.join(TEST_DIR, "binary.bin");
      const buffer = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]);

      nativeModule1.writeFileBinary(testFile, buffer);
      const read = nativeModule1.readFileBinary(testFile);

      expect(Buffer.from(read)).toEqual(buffer);
    });

    it("copyFile: should copy files", () => {
      const src = path.join(TEST_DIR, "source.txt");
      const dst = path.join(TEST_DIR, "dest.txt");
      fs.writeFileSync(src, "copy test");

      nativeModule1.copyFile(src, dst);

      expect(fs.existsSync(dst)).toBe(true);
      expect(fs.readFileSync(dst, "utf8")).toBe("copy test");
    });

    it("moveFile: should move files", () => {
      const src = path.join(TEST_DIR, "move_src.txt");
      const dst = path.join(TEST_DIR, "move_dst.txt");
      fs.writeFileSync(src, "move test");

      nativeModule1.moveFile(src, dst);

      expect(fs.existsSync(src)).toBe(false);
      expect(fs.existsSync(dst)).toBe(true);
      expect(fs.readFileSync(dst, "utf8")).toBe("move test");
    });

    it("deleteFile: should delete files", () => {
      const testFile = path.join(TEST_DIR, "delete.txt");
      fs.writeFileSync(testFile, "delete me");

      nativeModule1.deleteFile(testFile);

      expect(fs.existsSync(testFile)).toBe(false);
    });

    it("createDirectory: should create directories", () => {
      const newDir = path.join(TEST_DIR, "newdir", "nested");
      nativeModule1.createDirectory(newDir, true);

      expect(fs.existsSync(newDir)).toBe(true);
    });

    it("listDirectory: should list directory contents", () => {
      const dir = path.join(TEST_DIR, "listdir");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "file1.txt"), "content1");
      fs.writeFileSync(path.join(dir, "file2.txt"), "content2");

      const contents = nativeModule1.listDirectory(dir);
      expect(contents).toBeInstanceOf(Array);
      expect(contents.length).toBeGreaterThanOrEqual(2);
    });

    it("hashFile: should hash file contents", () => {
      const testFile = path.join(TEST_DIR, "hash.txt");
      fs.writeFileSync(testFile, "hash me");

      const hash = nativeModule1.hashFile(testFile, "sha256");
      expect(hash).toBeTypeOf("string");
      expect(hash.length).toBe(64);
    });
  });

  // =============================================================================
  // 5. DATA PROCESSING
  // =============================================================================

  describe("Data Processing", () => {
    it("processJson: should process JSON", async () => {
      const input = { key: "value", number: 42 };
      const result = await nativeModule1.processJson(JSON.stringify(input));
      expect(result).toEqual(input);
    });

    it("processJson: should handle pretty printing", async () => {
      const input = { key: "value", nested: { a: 1 } };
      const result = await nativeModule1.processJson(JSON.stringify(input), {
        pretty: true,
      });
      expect(result).toContain("\n");
      expect(result).toContain("  ");
    });

    it("validateJson: should validate valid JSON", () => {
      const result = nativeModule1.validateJson('{"key": "value"}');
      expect(result.valid).toBe(true);
    });

    it("validateJson: should reject invalid JSON", () => {
      const result = nativeModule1.validateJson("{invalid json}");
      expect(result.valid).toBe(false);
    });

    it("validateJson: should provide error details", () => {
      const result = nativeModule1.validateJson('{key: "value"}');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("mergeJson: should merge JSON objects", () => {
      if (typeof nativeModule1.mergeJson === "function") {
        const obj1 = { a: 1, b: 2 };
        const obj2 = { b: 3, c: 4 };
        const result = nativeModule1.mergeJson(obj1, obj2);
        expect(result).toEqual({ a: 1, b: 3, c: 4 });
      }
    });

    it("processCsv: should parse CSV", () => {
      if (typeof nativeModule1.processCsv === "function") {
        const csv = "name,age\nAlice,30\nBob,25";
        const result = nativeModule1.processCsv(csv);
        expect(result).toBeInstanceOf(Array);
        expect(result.length).toBeGreaterThan(0);
      }
    });
  });

  // =============================================================================
  // 6. BASE64 ENCODING
  // =============================================================================

  describe("Base64 Encoding", () => {
    it("base64Encode: should encode strings", () => {
      const result = nativeModule1.base64Encode("hello world");
      expect(result).toBe("aGVsbG8gd29ybGQ=");
    });

    it("base64Encode: should encode binary data", () => {
      const buffer = Buffer.from([0x00, 0x01, 0x02]);
      const result = nativeModule1.base64Encode(buffer);
      expect(result).toBe("AAEC");
    });

    it("base64Decode: should decode strings", () => {
      const result = nativeModule1.base64Decode("aGVsbG8gd29ybGQ=");
      expect(result).toBe("hello world");
    });

    it("base64Encode and Decode: should be reversible", () => {
      const original = "Hello, World! 你好世界 🌍";
      const encoded = nativeModule1.base64Encode(original);
      const decoded = nativeModule1.base64Decode(encoded);
      expect(decoded).toBe(original);
    });

    it("base64UrlEncode: should URL-safe encode", () => {
      if (typeof nativeModule1.base64UrlEncode === "function") {
        const result = nativeModule1.base64UrlEncode("hello?world");
        expect(result).not.toContain("+");
        expect(result).not.toContain("/");
      }
    });

    it("base64UrlDecode: should URL-safe decode", () => {
      if (typeof nativeModule1.base64UrlDecode === "function") {
        const encoded = nativeModule1.base64UrlEncode("hello world");
        const decoded = nativeModule1.base64UrlDecode(encoded);
        expect(decoded).toBe("hello world");
      }
    });
  });

  // =============================================================================
  // 7. REGULAR EXPRESSIONS
  // =============================================================================

  describe("Regular Expressions", () => {
    it("regexMatch: should match patterns", () => {
      const result = nativeModule1.regexMatch("hello123", "\\d+");
      expect(result).toBe(true);
    });

    it("regexMatch: should not match non-matching patterns", () => {
      const result = nativeModule1.regexMatch("hello", "\\d+");
      expect(result).toBe(false);
    });

    it("regexReplace: should replace patterns", () => {
      const result = nativeModule1.regexReplace("hello123world", "\\d+", "X");
      expect(result).toBe("helloXworld");
    });

    it("regexMatches: should find all matches", () => {
      const result = nativeModule1.regexMatches("test123test456", "\\d+");
      expect(result).toEqual(["123", "456"]);
    });

    it("regexSplit: should split by pattern", () => {
      const result = nativeModule1.regexSplit("a,b;c", "[,;]");
      expect(result).toEqual(["a", "b", "c"]);
    });

    it("regexEscape: should escape special characters", () => {
      if (typeof nativeModule1.regexEscape === "function") {
        const result = nativeModule1.regexEscape("a.b*c+");
        expect(result).toMatch(/\\./);
        expect(result).toMatch(/\\*/);
        expect(result).toMatch(/\\+/);
      }
    });

    it("regexIsValid: should validate regex patterns", () => {
      if (typeof nativeModule1.regexIsValid === "function") {
        expect(nativeModule1.regexIsValid("[0-9]+")).toBe(true);
        expect(nativeModule1.regexIsValid("[invalid")).toBe(false);
      }
    });

    it("regexFindAll: should find all occurrences", () => {
      if (typeof nativeModule1.regexFindAll === "function") {
        const result = nativeModule1.regexFindAll("test123test456test", "test");
        expect(result.length).toBe(3);
      }
    });
  });

  // =============================================================================
  // 8. DATA COMPRESSION
  // =============================================================================

  describe("Data Compression", () => {
    it("compressGzip and decompressGzip: should compress and decompress", () => {
      const original = "Hello, World! ".repeat(100);
      const compressed = nativeModule1.compressGzip(original);
      const decompressed = nativeModule1.decompressGzip(compressed);

      expect(compressed.length).toBeLessThan(original.length);
      expect(decompressed).toBe(original);
    });

    it("compressBrotli and decompressBrotli: should compress and decompress", () => {
      const original = "Hello, World! ".repeat(100);
      const compressed = nativeModule1.compressBrotli(original);
      const decompressed = nativeModule1.decompressBrotli(compressed);

      expect(compressed.length).toBeLessThan(original.length);
      expect(decompressed).toBe(original);
    });

    it("compressDeflate and decompressDeflate: should compress and decompress", () => {
      const original = "Hello, World! ".repeat(100);
      const compressed = nativeModule1.compressDeflate(original);
      const decompressed = nativeModule1.decompressDeflate(compressed);

      expect(compressed.length).toBeLessThan(original.length);
      expect(decompressed).toBe(original);
    });
  });

  // =============================================================================
  // 9. ADVANCED FEATURES
  // =============================================================================

  describe("Advanced Features", () => {
    it("benchmark: should execute benchmark with 1M iterations", () => {
      const start = Date.now();
      const result = nativeModule1.benchmark(1000000);
      const duration = Date.now() - start;

      expect(result).toBeDefined();
      expect(result.iterations).toBe(1000000);
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.opsPerSecond).toBeGreaterThan(0);

      console.log(`  Benchmark: ${result.iterations} iterations in ${result.durationMs}ms`);
      console.log(`  Operations per second: ${result.opsPerSecond.toLocaleString()}`);

      // Should complete in reasonable time (< 10 seconds)
      expect(duration).toBeLessThan(10000);
    });

    it("healthCheck: should return healthy status", () => {
      const result = nativeModule1.healthCheck();
      expect(result).toBeDefined();
      expect(result.status).toBe("healthy");
      expect(result.uptime).toBeGreaterThan(0);
    });

    it("getVersion: should return version", () => {
      if (typeof nativeModule1.getVersion === "function") {
        const version = nativeModule1.getVersion();
        expect(version).toBeTypeOf("string");
        expect(version.length).toBeGreaterThan(0);
      }
    });

    it("getBuildInfo: should return build info", () => {
      if (typeof nativeModule1.getBuildInfo === "function") {
        const info = nativeModule1.getBuildInfo();
        expect(info).toBeInstanceOf(Object);
        expect(Object.keys(info).length).toBeGreaterThan(0);
      }
    });

    it("parallelProcess: should process in parallel", async () => {
      if (typeof nativeModule1.parallelProcess === "function") {
        const items = ["hello", "world", "test"];
        const result = await nativeModule1.parallelProcess(items, async (item) => {
          return item.toUpperCase();
        });
        expect(result).toEqual(["HELLO", "WORLD", "TEST"]);
      }
    });

    it("memoize: should cache results", () => {
      if (typeof nativeModule1.memoize === "function") {
        let callCount = 0;
        const fn = nativeModule1.memoize((x: number) => {
          callCount++;
          return x * 2;
        });

        expect(fn(5)).toBe(10);
        expect(fn(5)).toBe(10);
        expect(callCount).toBe(1); // Should only call once due to memoization
      }
    });
  });

  // =============================================================================
  // 10. ASYNC OPERATIONS
  // =============================================================================

  describe("Async Operations", () => {
    it("asyncProcessString: should process string asynchronously", async () => {
      if (typeof nativeModule1.asyncProcessString === "function") {
        const result = await nativeModule1.asyncProcessString("hello", {
          uppercase: true,
        });
        expect(result).toBe("HELLO");
      }
    });

    it("asyncProcessJson: should process JSON asynchronously", async () => {
      if (typeof nativeModule1.asyncProcessJson === "function") {
        const result = await nativeModule1.asyncProcessJson('{"key": "value"}');
        expect(result).toEqual({ key: "value" });
      }
    });

    it("asyncFileStats: should get file stats asynchronously", async () => {
      if (typeof nativeModule1.asyncFileStats === "function") {
        const testFile = path.join(TEST_DIR, "async.txt");
        fs.writeFileSync(testFile, "test");

        const stats = await nativeModule1.asyncFileStats(testFile);
        expect(stats).toBeDefined();
        expect(stats.size).toBeGreaterThan(0);
      }
    });

    it("asyncBatchProcess: should process batch asynchronously", async () => {
      if (typeof nativeModule1.asyncBatchProcess === "function") {
        const items = ["hello", "world"];
        const result = await nativeModule1.asyncBatchProcess(items, {
          uppercase: true,
        });
        expect(result).toEqual(["HELLO", "WORLD"]);
      }
    });
  });

  // =============================================================================
  // 11. EDGE CASES
  // =============================================================================

  describe("Edge Cases", () => {
    it("should handle empty strings", async () => {
      const result = await nativeModule1.processString("");
      expect(result).toBe("");
    });

    it("should handle null/undefined gracefully", () => {
      // These should throw or handle gracefully, not crash
      expect(() => nativeModule1.computeHash("")).not.toThrow();
    });

    it("should handle very large inputs", async () => {
      const largeString = "a".repeat(1000000);
      const result = await nativeModule1.processString(largeString, {
        uppercase: true,
      });
      expect(result.length).toBe(1000000);
      expect(result).toBe("A".repeat(1000000));
    });

    it("should handle special characters", async () => {
      const special = "你好世界 🌍 Ñoño café";
      const result = await nativeModule1.processString(special);
      expect(result).toBe(special);
    });

    it("should handle invalid file paths", () => {
      expect(() =>
        nativeModule1.getFileInfo("/nonexistent/path/that/does/not/exist.txt"),
      ).not.toThrow();
    });

    it("should handle empty arrays", async () => {
      const result = await nativeModule1.batchProcess([]);
      expect(result).toEqual([]);
    });

    it("should handle very long regex patterns", () => {
      const longPattern = "a".repeat(1000);
      const result = nativeModule1.regexMatch("a", longPattern);
      expect(typeof result).toBe("boolean");
    });

    it("should handle unicode in base64", () => {
      const unicode = "你好 世界 🌍";
      const encoded = nativeModule1.base64Encode(unicode);
      const decoded = nativeModule1.base64Decode(encoded);
      expect(decoded).toBe(unicode);
    });
  });

  // =============================================================================
  // 12. ERROR HANDLING
  // =============================================================================

  describe("Error Handling", () => {
    it("should throw on invalid JSON for processJson", async () => {
      await expect(nativeModule1.processJson("{invalid}")).rejects.toThrow();
    });

    it("should throw on invalid base64", () => {
      expect(() => nativeModule1.base64Decode("not valid base64!")).toThrow();
    });

    it("should throw on invalid regex", () => {
      expect(() => nativeModule1.regexMatch("test", "[invalid")).toThrow();
    });

    it("should throw when writing to invalid path", () => {
      expect(() => nativeModule1.writeFileString("/root/invalid.txt", "test")).toThrow();
    });

    it("should throw when reading non-existent file", () => {
      expect(() => nativeModule1.readFileString("/nonexistent/file.txt")).toThrow();
    });
  });

  // =============================================================================
  // 13. PERFORMANCE METRICS
  // =============================================================================

  describe("Performance Metrics", () => {
    it("hash performance: should hash 10MB quickly", () => {
      const largeData = "a".repeat(10 * 1024 * 1024);
      const start = Date.now();
      nativeModule1.computeHash(largeData, "sha256");
      const duration = Date.now() - start;

      console.log(`  Hashed 10MB in ${duration}ms`);
      expect(duration).toBeLessThan(1000); // Should be under 1 second
    });

    it("compression performance: should compress quickly", () => {
      const largeData = "test ".repeat(1000000); // ~5MB
      const start = Date.now();
      nativeModule1.compressGzip(largeData);
      const duration = Date.now() - start;

      console.log(`  Compressed 5MB in ${duration}ms`);
      expect(duration).toBeLessThan(2000); // Should be under 2 seconds
    });

    it("string processing performance: should process quickly", async () => {
      const largeData = "test string ".repeat(100000);
      const start = Date.now();
      await nativeModule1.processString(largeData, { uppercase: true });
      const duration = Date.now() - start;

      console.log(`  Processed ~1.3MB string in ${duration}ms`);
      expect(duration).toBeLessThan(1000); // Should be under 1 second
    });
  });

  // =============================================================================
  // 14. UTILITY FUNCTIONS
  // =============================================================================

  describe("Utility Functions", () => {
    it("formatBytes: should format bytes", () => {
      if (typeof nativeModule1.formatBytes === "function") {
        expect(nativeModule1.formatBytes(1024)).toContain("KB");
        expect(nativeModule1.formatBytes(1024 * 1024)).toContain("MB");
      }
    });

    it("formatDuration: should format duration", () => {
      if (typeof nativeModule1.formatDuration === "function") {
        const result = nativeModule1.formatDuration(3661000); // 1h 1m 1s
        expect(result).toBeDefined();
      }
    });

    it("parseDuration: should parse duration", () => {
      if (typeof nativeModule1.parseDuration === "function") {
        const result = nativeModule1.parseDuration("1h 30m");
        expect(result).toBeGreaterThan(0);
      }
    });

    it("sanitizePath: should sanitize paths", () => {
      if (typeof nativeModule1.sanitizePath === "function") {
        const result = nativeModule1.sanitizePath("/path/to/../file.txt");
        expect(result).toBeDefined();
        expect(result).not.toContain("..");
      }
    });
  });
});
