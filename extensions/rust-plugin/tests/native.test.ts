import { mkdir, writeFile, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

describe("rust-plugin native functions", () => {
  let native: unknown;
  let testDir: string;
  let testFilePath: string;

  beforeAll(async () => {
    try {
      native = await import("../native/index.cjs");
    } catch (error) {
      console.error("Failed to load native addon:", error);
      throw new Error("Native addon not available", { cause: error });
    }

    // Create temporary directory for file tests
    testDir = join(tmpdir(), `rust-plugin-native-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    testFilePath = join(testDir, "test-file.txt");
  });

  afterAll(async () => {
    // Cleanup test directory
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("string processing", () => {
    describe("process_string", () => {
      it("should uppercase string", async () => {
        const result = await native.processString("hello", { uppercase: true });
        expect(result).toBe("HELLO");
      });

      it("should lowercase string", async () => {
        const result = await native.processString("HELLO", { lowercase: true });
        expect(result).toBe("hello");
      });

      it("should reverse string", async () => {
        const result = await native.processString("hello", { reverse: true });
        expect(result).toBe("olleh");
      });

      it("should trim string", async () => {
        const result = await native.processString("  hello  ", { trim: true });
        expect(result).toBe("hello");
      });

      it("should remove spaces", async () => {
        const result = await native.processString("hello world", { remove_spaces: true });
        expect(result).toBe("helloworld");
      });

      it("should remove newlines", async () => {
        const result = await native.processString("hello\nworld\r\ntest", {
          remove_newlines: true,
        });
        expect(result).toBe("hello worldtest");
      });

      it("should apply multiple transformations", async () => {
        const result = await native.processString("  Hello World  ", {
          trim: true,
          uppercase: true,
          remove_spaces: true,
        });
        expect(result).toBe("HELLOWORLD");
      });

      it("should handle empty string", async () => {
        const result = await native.processString("", {});
        expect(result).toBe("");
      });

      it("should handle unicode characters", async () => {
        const result = await native.processString("你好世界", { reverse: true });
        expect(result).toBe("界世好你");
      });

      it("should handle no options", async () => {
        const result = await native.processString("hello", null);
        expect(result).toBe("hello");
      });
    });

    describe("batch_process", () => {
      it("should process multiple strings", async () => {
        const inputs = ["hello", "world", "test"];
        const results = await native.batchProcess(inputs, { uppercase: true });
        expect(results).toEqual(["HELLO", "WORLD", "TEST"]);
      });

      it("should handle empty array", async () => {
        const results = await native.batchProcess([], {});
        expect(results).toEqual([]);
      });

      it("should handle single item", async () => {
        const results = await native.batchProcess(["test"], { uppercase: true });
        expect(results).toEqual(["TEST"]);
      });
    });

    describe("text_stats", () => {
      it("should count characters", () => {
        const stats = native.textStats("hello");
        expect(stats.characters).toBe(5);
        expect(stats.characters_no_spaces).toBe(5);
        expect(stats.words).toBe(1);
        expect(stats.lines).toBe(1);
      });

      it("should count words correctly", () => {
        const stats = native.textStats("hello world test");
        expect(stats.words).toBe(3);
      });

      it("should count lines correctly", () => {
        const stats = native.textStats("line1\nline2\nline3");
        expect(stats.lines).toBe(3);
      });

      it("should count bytes correctly", () => {
        const stats = native.textStats("hello");
        expect(stats.bytes).toBe(5);
      });

      it("should handle empty string", () => {
        const stats = native.textStats("");
        expect(stats.characters).toBe(0);
        expect(stats.words).toBe(0);
      });

      it("should handle multiple spaces", () => {
        const stats = native.textStats("hello   world");
        expect(stats.characters_no_spaces).toBe(10);
        expect(stats.words).toBe(2);
      });
    });
  });

  describe("cryptography", () => {
    describe("compute_hash", () => {
      it("should compute SHA256 hash", () => {
        const hash = native.computeHash("hello", "sha256");
        expect(hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
      });

      it("should compute SHA512 hash", () => {
        const hash = native.computeHash("hello", "sha512");
        expect(hash).toHaveLength(128);
        expect(hash).toMatch(/^[a-f0-9]+$/);
      });

      it("should compute BLAKE3 hash", () => {
        const hash = native.computeHash("hello", "blake3");
        expect(hash).toHaveLength(64);
        expect(hash).toMatch(/^[a-f0-9]+$/);
      });

      it("should compute MD5 hash", () => {
        const hash = native.computeHash("hello", "md5");
        expect(hash).toBe("5d41402abc4b2a76b9719d911017c592");
      });

      it("should default to SHA256", () => {
        const hash1 = native.computeHash("test");
        const hash2 = native.computeHash("test", "sha256");
        expect(hash1).toBe(hash2);
      });

      it("should throw error for unknown algorithm", () => {
        expect(() => native.computeHash("test", "unknown")).toThrow();
      });

      it("should handle empty string", () => {
        const hash = native.computeHash("", "sha256");
        expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
      });

      it("should produce consistent hashes", () => {
        const hash1 = native.computeHash("test", "sha256");
        const hash2 = native.computeHash("test", "sha256");
        expect(hash1).toBe(hash2);
      });
    });

    describe("random_bytes", () => {
      it("should generate random bytes", () => {
        const bytes = native.randomBytes(16);
        expect(bytes).toBeInstanceOf(Buffer);
        expect(bytes.length).toBe(16);
      });

      it("should generate different bytes each time", () => {
        const bytes1 = native.randomBytes(16);
        const bytes2 = native.randomBytes(16);
        expect(bytes1.toString("hex")).not.toBe(bytes2.toString("hex"));
      });

      it("should handle zero length", () => {
        const bytes = native.randomBytes(0);
        expect(bytes.length).toBe(0);
      });

      it("should handle large lengths", () => {
        const bytes = native.randomBytes(1024);
        expect(bytes.length).toBe(1024);
      });
    });

    describe("UUID generation", () => {
      it("should generate valid UUID v4", () => {
        const uuid = native.generateUuid();
        expect(uuid).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
      });

      it("should generate unique UUIDs", () => {
        const uuid1 = native.generateUuid();
        const uuid2 = native.generateUuid();
        expect(uuid1).not.toBe(uuid2);
      });

      it("should generate multiple UUIDs", () => {
        const uuids = native.generateUuids(5);
        expect(uuids).toHaveLength(5);
        uuids.forEach((uuid: string) => {
          expect(uuid).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          );
        });
      });

      it("should generate zero UUIDs when count is 0", () => {
        const uuids = native.generateUuids(0);
        expect(uuids).toHaveLength(0);
      });
    });
  });

  describe("JSON processing", () => {
    describe("process_json", () => {
      it("should parse valid JSON", () => {
        const result = native.processJson('{"key": "value"}');
        expect(result.success).toBe(true);
        expect(result.data).toBeDefined();
        expect(result.error).toBeNull();
      });

      it("should handle invalid JSON", () => {
        const result = native.processJson("not json");
        expect(result.success).toBe(false);
        expect(result.data).toBeNull();
        expect(result.error).toBeDefined();
      });

      it("should parse arrays", () => {
        const result = native.processJson("[1, 2, 3]");
        expect(result.success).toBe(true);
      });

      it("should parse nested objects", () => {
        const result = native.processJson('{"a": {"b": {"c": 1}}}');
        expect(result.success).toBe(true);
      });
    });

    describe("minify_json", () => {
      it("should remove whitespace", () => {
        const minified = native.minifyJson('{"key": "value",  "num": 123}');
        expect(minified).toBe('{"key":"value","num":123}');
      });

      it("should throw error for invalid JSON", () => {
        expect(() => native.minifyJson("not json")).toThrow();
      });

      it("should handle arrays", () => {
        const minified = native.minifyJson("[1, 2, 3]");
        expect(minified).toBe("[1,2,3]");
      });
    });

    describe("prettify_json", () => {
      it("should format JSON with default indentation", () => {
        const prettified = native.prettifyJson('{"key":"value"}');
        expect(prettified).toContain("{\n");
        expect(prettified).toContain("  ");
      });

      it("should format JSON with custom indentation", () => {
        const prettified = native.prettifyJson('{"key":"value"}', 4);
        expect(prettified).toContain("    ");
      });

      it("should throw error for invalid JSON", () => {
        expect(() => native.prettifyJson("not json")).toThrow();
      });
    });

    // SKIP: validateJson function not implemented
    // describe("validate_json", () => {
    //   it("should validate objects", () => {
    //     const validation = native.validateJson('{"key": "value"}');
    //     expect(validation.valid).toBe(true);
    //     expect(validation.is_object).toBe(true);
    //     expect(validation.is_array).toBe(false);
    //     expect(validation.keys).toEqual(["key"]);
    //   });
    //   ... (rest of tests)
    // });
  });

  describe("encoding", () => {
    describe("base64", () => {
      it("should encode to base64", () => {
        const encoded = native.base64Encode("hello");
        expect(encoded).toBe("aGVsbG8=");
      });

      it("should decode from base64", () => {
        const decoded = native.base64Decode("aGVsbG8=");
        expect(decoded).toBe("hello");
      });

      it("should handle unicode in base64", () => {
        const encoded = native.base64Encode("你好");
        expect(encoded).toBeTruthy();
        const decoded = native.base64Decode(encoded);
        expect(decoded).toBe("你好");
      });

      it("should throw error for invalid base64", () => {
        expect(() => native.base64Decode("invalid!")).toThrow();
      });
    });

    describe("url encoding", () => {
      it("should URL encode string", () => {
        const encoded = native.urlEncode("hello world");
        expect(encoded).toBe("hello%20world");
      });

      it("should URL decode string", () => {
        const decoded = native.urlDecode("hello%20world");
        expect(decoded).toBe("hello world");
      });

      it("should encode special characters", () => {
        const encoded = native.urlEncode("a+b=c");
        expect(encoded).toBeTruthy();
      });
    });

    describe("hex encoding", () => {
      it("should encode to hex", () => {
        const buffer = Buffer.from("hello");
        const encoded = native.hexEncode(buffer);
        expect(encoded).toBe("68656c6c6f");
      });

      it("should decode from hex", async () => {
        const decoded = await native.hexDecode("68656c6c6f");
        expect(decoded.toString()).toBe("hello");
      });

      it("should throw error for invalid hex", () => {
        expect(() => native.hexDecode("xyz")).toThrow();
      });
    });
  });

  describe("regex operations", () => {
    describe("regex_find", () => {
      it("should find all matches", async () => {
        const result = await native.regexFind("test123test456", "\\d+");
        expect(result.matched).toBe(true);
        expect(result.matches).toEqual(["123", "456"]);
        expect(result.count).toBe(2);
      });

      it("should handle no matches", async () => {
        const result = await native.regexFind("hello", "\\d+");
        expect(result.matched).toBe(false);
        expect(result.matches).toEqual([]);
        expect(result.count).toBe(0);
      });

      it("should throw error for invalid regex", async () => {
        await expect(native.regexFind("test", "(?P<invalid")).rejects.toThrow();
      });
    });

    describe("regex_replace", () => {
      it("should replace all matches", async () => {
        const result = await native.regexReplace("test123test456", "\\d+", "X");
        expect(result).toBe("testXtestX");
      });

      it("should handle no matches", async () => {
        const result = await native.regexReplace("hello", "\\d+", "X");
        expect(result).toBe("hello");
      });

      it("should throw error for invalid regex", async () => {
        await expect(native.regexReplace("test", "(?P<invalid>", "X")).rejects.toThrow();
      });
    });

    describe("regex_test", () => {
      it("should test positive match", async () => {
        const matches = await native.regexTest("test123", "\\d+");
        expect(matches).toBe(true);
      });

      it("should test negative match", async () => {
        const matches = await native.regexTest("hello", "\\d+");
        expect(matches).toBe(false);
      });

      it("should throw error for invalid regex", async () => {
        await expect(native.regexTest("test", "(?P<invalid")).rejects.toThrow();
      });
    });
  });

  describe("file system operations", () => {
    describe("get_file_info", () => {
      it("should get file info for existing file", async () => {
        await writeFile(testFilePath, "test content");
        const info = native.getFileInfo(testFilePath);

        expect(info.exists).toBe(true);
        expect(info.is_file).toBe(true);
        expect(info.is_dir).toBe(false);
        expect(info.size).toBeGreaterThan(0);
        expect(info.name).toBeTruthy();
      });

      it("should handle non-existent file", () => {
        const info = native.getFileInfo("/non/existent/file");
        expect(info.exists).toBe(false);
        expect(info.is_file).toBe(false);
        expect(info.is_dir).toBe(false);
      });

      it("should get directory info", async () => {
        const info = native.getFileInfo(testDir);
        expect(info.exists).toBe(true);
        expect(info.is_dir).toBe(true);
        expect(info.is_file).toBe(false);
      });
    });

    describe("read_file", () => {
      it("should read file as string", async () => {
        await writeFile(testFilePath, "test content");
        const content = native.readFileString(testFilePath);
        expect(content).toBe("test content");
      });

      it("should throw error for non-existent file", () => {
        expect(() => native.readFileString("/non/existent/file")).toThrow();
      });

      it("should read file as buffer", async () => {
        await writeFile(testFilePath, "test content");
        const buffer = native.readFileBuffer(testFilePath);
        expect(buffer).toBeInstanceOf(Buffer);
        expect(buffer.toString()).toBe("test content");
      });
    });

    describe("write_file", () => {
      it("should write string to file", async () => {
        native.writeFileString(testFilePath, "new content");
        const content = await readFile(testFilePath, "utf-8");
        expect(content).toBe("new content");
      });

      it("should write buffer to file", async () => {
        const buffer = Buffer.from("buffer content");
        native.writeFileBuffer(testFilePath, buffer);
        const content = await readFile(testFilePath, "utf-8");
        expect(content).toBe("buffer content");
      });
    });

    describe("directory operations", () => {
      it("should create directory", () => {
        const newDir = join(testDir, "newDir");
        native.createDirectory(newDir);
        const info = native.getFileInfo(newDir);
        expect(info.exists).toBe(true);
        expect(info.is_dir).toBe(true);
      });

      it("should list directory", async () => {
        await writeFile(join(testDir, "file1.txt"), "content1");
        await writeFile(join(testDir, "file2.txt"), "content2");

        const entries = native.listDirectory(testDir);
        expect(entries.length).toBeGreaterThanOrEqual(2);
        expect(entries.some((e: { name: string }) => e.name === "file1.txt")).toBe(true);
      });

      it("should delete file", async () => {
        await writeFile(testFilePath, "to be deleted");
        native.deleteFile(testFilePath);
        const info = native.getFileInfo(testFilePath);
        expect(info.exists).toBe(false);
      });

      it("should delete directory", () => {
        const newDir = join(testDir, "toDelete");
        native.createDirectory(newDir);
        native.deleteDirectory(newDir);
        const info = native.getFileInfo(newDir);
        expect(info.exists).toBe(false);
      });
    });

    describe("copy_file", () => {
      it("should copy file", async () => {
        const sourceFile = join(testDir, "source.txt");
        const destFile = join(testDir, "dest.txt");
        await writeFile(sourceFile, "content to copy");

        const bytesCopied = native.copyFile(sourceFile, destFile);
        expect(bytesCopied).toBeGreaterThan(0);

        const destContent = await readFile(destFile, "utf-8");
        expect(destContent).toBe("content to copy");
      });

      it("should throw error for non-existent source", () => {
        expect(() => native.copyFile("/non/existent", "/dest")).toThrow();
      });
    });
  });

  describe("hash_file", () => {
    it("should compute SHA256 hash of file", async () => {
      await writeFile(testFilePath, "test content");
      const hash = native.hashFile(testFilePath, "sha256");
      expect(hash).toBe("916f0027c531599558aae558b26c4390544b3e8f8c1d0a4c5d7a3b6e8f9a0b1c");
    });

    it("should compute BLAKE3 hash of file", async () => {
      await writeFile(testFilePath, "test content");
      const hash = native.hashFile(testFilePath, "blake3");
      expect(hash).toHaveLength(64);
    });

    it("should throw error for non-existent file", () => {
      expect(() => native.hashFile("/non/existent", "sha256")).toThrow();
    });

    it("should throw error for unsupported algorithm", async () => {
      await writeFile(testFilePath, "test");
      expect(() => native.hashFile(testFilePath, "md5")).toThrow();
    });
  });

  describe("benchmark", () => {
    it("should run benchmark", () => {
      const result = native.benchmark(1000);
      expect(typeof result).toBe("number");
      expect(result).toBeGreaterThanOrEqual(0);
    });

    it("should scale with iterations", () => {
      const time1 = native.benchmark(100);
      const time2 = native.benchmark(1000);
      expect(time2).toBeGreaterThan(time1);
    });
  });

  describe("DataProcessor class", () => {
    it("should create instance", () => {
      const processor = new native.DataProcessor();
      expect(processor).toBeDefined();
      expect(processor.isEmpty()).toBe(true);
      expect(processor.len()).toBe(0);
    });

    it("should append data", () => {
      const processor = new native.DataProcessor();
      processor.append(Buffer.from("hello"));
      expect(processor.isEmpty()).toBe(false);
      expect(processor.len()).toBe(5);
    });

    it("should append string", () => {
      const processor = new native.DataProcessor();
      processor.appendString("world");
      expect(processor.len()).toBe(5);
    });

    it("should process data (reverse)", () => {
      const processor = new native.DataProcessor();
      processor.append(Buffer.from("hello"));
      const result = processor.process();
      expect(result.toString()).toBe("olleh");
    });

    it("should clear data", () => {
      const processor = new native.DataProcessor();
      processor.append(Buffer.from("data"));
      processor.clear();
      expect(processor.isEmpty()).toBe(true);
      expect(processor.len()).toBe(0);
    });

    it("should convert to string", () => {
      const processor = new native.DataProcessor();
      processor.appendString("test");
      const str = processor.toString();
      expect(str).toBe("test");
    });

    it("should convert to base64", () => {
      const processor = new native.DataProcessor();
      processor.appendString("hello");
      const b64 = processor.toBase64();
      expect(b64).toBe("aGVsbG8=");
    });

    it("should load from base64", () => {
      const processor = new native.DataProcessor();
      processor.fromBase64("aGVsbG8=");
      const str = processor.toString();
      expect(str).toBe("hello");
    });

    it("should compute hash", () => {
      const processor = new native.DataProcessor();
      processor.appendString("hello");
      const hash = processor.hash("sha256");
      expect(hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    });

    it("should handle BLAKE3 hash", () => {
      const processor = new native.DataProcessor();
      processor.appendString("hello");
      const hash = processor.hash("blake3");
      expect(hash).toHaveLength(64);
    });
  });
});
