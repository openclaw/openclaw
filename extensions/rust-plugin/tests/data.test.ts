import { describe, it, expect, beforeAll } from "vitest";

describe("rust-plugin data processing", () => {
  let native: unknown;

  beforeAll(async () => {
    try {
      native = await import("../native/index.cjs");
    } catch (error) {
      console.error("Failed to load native addon:", error);
      throw new Error("Native addon not available", { cause: error });
    }
  });

  describe("compression", () => {
    describe("rle_compress", () => {
      it("should compress simple repeated characters", () => {
        const result = native.rleCompress("aaaaabbbbcc");
        expect(result.compressed).toBeDefined();
        expect(result.originalSize).toBe(11);
        expect(result.compressedSize).toBeGreaterThan(0);
        expect(result.ratio).toBeGreaterThan(0);
      });

      it("should compress single character", () => {
        const result = native.rleCompress("a");
        expect(result.originalSize).toBe(1);
        expect(result.compressedSize).toBeGreaterThan(0);
      });

      it("should compress empty string", () => {
        const result = native.rleCompress("");
        expect(result.originalSize).toBe(0);
      });

      it("should compress string with no repeats", () => {
        const result = native.rleCompress("abc");
        expect(result.originalSize).toBe(3);
        expect(result.compressedSize).toBeGreaterThan(0);
      });

      it("should handle unicode characters", () => {
        const result = native.rleCompress("你好你好");
        expect(result.compressed).toBeDefined();
      });

      it("should calculate compression ratio correctly", () => {
        const result = native.rleCompress("aaaaaaaaaa"); // 10 'a's
        expect(result.ratio).toBeLessThan(1); // Should compress
      });
    });

    describe("rle_decompress", () => {
      it("should decompress compressed data", () => {
        const compressed = native.rleCompress("aaaaabbbbcc");
        const decompressed = native.rleDecompress(compressed.compressed);

        expect(decompressed.success).toBe(true);
        expect(decompressed.data).toBe("aaaaabbbbcc");
        expect(decompressed.error).toBeNull();
      });

      it("should handle single character", () => {
        const compressed = native.rleCompress("a");
        const decompressed = native.rleDecompress(compressed.compressed);
        expect(decompressed.data).toBe("a");
      });

      it("should handle empty string", () => {
        const compressed = native.rleCompress("");
        const decompressed = native.rleDecompress(compressed.compressed);
        expect(decompressed.data).toBe("");
      });

      it("should handle invalid compressed data", () => {
        const result = native.rleDecompress("invalid");
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      });

      it("should maintain unicode through compression roundtrip", () => {
        const original = "你好世界";
        const compressed = native.rleCompress(original);
        const decompressed = native.rleDecompress(compressed.compressed);
        expect(decompressed.data).toBe(original);
      });
    });

    describe("compression roundtrip", () => {
      it("should maintain data integrity", () => {
        const testCases = [
          "hello world",
          "aaaaaaaaaa",
          "abc",
          "",
          "a",
          "The quick brown fox jumps over the lazy dog",
        ];

        testCases.forEach((original) => {
          const compressed = native.rleCompress(original);
          const decompressed = native.rleDecompress(compressed.compressed);
          expect(decompressed.data).toBe(original);
        });
      });
    });
  });

  describe("tokenization", () => {
    describe("tokenize", () => {
      it("should tokenize into words", () => {
        const tokens = native.tokenize("Hello, world! How are you?");
        expect(tokens).toContain("Hello");
        expect(tokens).toContain("world");
        expect(tokens).toContain(",");
        expect(tokens).toContain("!");
      });

      it("should tokenize into lines", () => {
        const tokens = native.tokenize("line1\nline2\nline3", "lines");
        expect(tokens).toHaveLength(3);
        expect(tokens[0]).toBe("line1");
        expect(tokens[1]).toBe("line2");
        expect(tokens[2]).toBe("line3");
      });

      it("should tokenize into characters", () => {
        const tokens = native.tokenize("abc", "chars");
        expect(tokens).toEqual(["a", "b", "c"]);
      });

      it("should tokenize into sentences", () => {
        const tokens = native.tokenize("Hello world. How are you? I'm fine!", "sentences");
        expect(tokens.length).toBeGreaterThan(0);
        expect(tokens[0]).toContain("Hello");
      });

      it("should throw error for unknown mode", () => {
        expect(() => native.tokenize("test", "unknown")).toThrow();
      });

      it("should handle empty string", () => {
        const tokens = native.tokenize("", "words");
        expect(Array.isArray(tokens)).toBe(true);
      });

      it("should handle unicode in words mode", () => {
        const tokens = native.tokenize("你好世界", "words");
        expect(tokens).toContain("你好世界");
      });

      it("should default to words mode", () => {
        const tokens1 = native.tokenize("test");
        const tokens2 = native.tokenize("test", "words");
        expect(tokens1).toEqual(tokens2);
      });
    });
  });

  describe("text statistics", () => {
    describe("text_statistics", () => {
      it("should calculate basic statistics", () => {
        const stats = native.extendedTextStats("Hello world");
        expect(stats.characters).toBe(11);
        expect(stats.characters_no_spaces).toBe(10);
        expect(stats.words).toBe(2);
        expect(stats.lines).toBe(1);
      });

      it("should count paragraphs", () => {
        const stats = native.extendedTextStats("Para 1\n\nPara 2\n\nPara 3");
        expect(stats.paragraphs).toBe(3);
      });

      it("should count sentences", () => {
        const stats = native.extendedTextStats("Hello. World! How are you?");
        expect(stats.sentences).toBeGreaterThanOrEqual(2);
      });

      it("should calculate average word length", () => {
        const stats = native.extendedTextStats("hello world");
        expect(stats.avg_word_length).toBeCloseTo(5.0, 1);
      });

      it("should calculate average sentence length", () => {
        const stats = native.extendedTextStats("Hello world. How are you?");
        expect(stats.avg_sentence_length).toBeGreaterThan(0);
      });

      it("should handle empty string", () => {
        const stats = native.extendedTextStats("");
        expect(stats.characters).toBe(0);
        expect(stats.words).toBe(0);
        expect(stats.avg_word_length).toBe(0);
      });

      it("should handle multiple lines", () => {
        const stats = native.extendedTextStats("line1\nline2\nline3");
        expect(stats.lines).toBe(3);
      });
    });
  });

  describe("text transformation", () => {
    describe("transform_text", () => {
      it("should apply uppercase transformation", () => {
        const result = native.transformText("hello", ["uppercase"]);
        expect(result).toBe("HELLO");
      });

      it("should apply lowercase transformation", () => {
        const result = native.transformText("HELLO", ["lowercase"]);
        expect(result).toBe("hello");
      });

      it("should apply reverse transformation", () => {
        const result = native.transformText("hello", ["reverse"]);
        expect(result).toBe("olleh");
      });

      it("should apply trim transformation", () => {
        const result = native.transformText("  hello  ", ["trim"]);
        expect(result).toBe("hello");
      });

      it("should apply normalize transformation", () => {
        const result = native.transformText("hello   world  test", ["normalize"]);
        expect(result).toBe("hello world test");
      });

      it("should apply deduplicate transformation", () => {
        const result = native.transformText("aaabbbccc", ["deduplicate"]);
        expect(result).toBe("abc");
      });

      it("should apply sort_words transformation", () => {
        const result = native.transformText("zebra apple banana", ["sort_words"]);
        expect(result).toBe("apple banana zebra");
      });

      it("should apply sort_chars transformation", () => {
        const result = native.transformText("cba", ["sort_chars"]);
        expect(result).toBe("abc");
      });

      it("should apply multiple transformations in sequence", () => {
        const result = native.transformText("  Hello World  ", ["trim", "lowercase", "reverse"]);
        expect(result).toBe("dlrow olleh");
      });

      it("should throw error for unknown operation", () => {
        expect(() => native.transformText("test", ["unknown"])).toThrow();
      });

      it("should handle empty operations array", () => {
        const result = native.transformText("test", []);
        expect(result).toBe("test");
      });

      it("should handle empty string", () => {
        const result = native.transformText("", ["uppercase"]);
        expect(result).toBe("");
      });
    });
  });

  describe("pattern matching", () => {
    describe("pattern_match", () => {
      it("should match exact pattern", () => {
        const matches = native.patternMatch("hello", "hello");
        expect(matches).toBe(true);
      });

      it("should match with wildcard *", () => {
        expect(native.patternMatch("hello", "h*o")).toBe(true);
        expect(native.patternMatch("hello", "h*")).toBe(true);
        expect(native.patternMatch("hello", "*o")).toBe(true);
        expect(native.patternMatch("hello", "*")).toBe(true);
      });

      it("should match with wildcard ?", () => {
        expect(native.patternMatch("hello", "h??lo")).toBe(true);
        expect(native.patternMatch("hello", "?????")).toBe(true);
      });

      it("should combine wildcards", () => {
        expect(native.patternMatch("hello world", "h*o*?")).toBe(true);
      });

      it("should not match incorrect patterns", () => {
        expect(native.patternMatch("hello", "world")).toBe(false);
        expect(native.patternMatch("hello", "h??")).toBe(false);
      });

      it("should handle empty strings", () => {
        expect(native.patternMatch("", "")).toBe(true);
        expect(native.patternMatch("", "*")).toBe(true);
        expect(native.patternMatch("hello", "")).toBe(false);
      });

      it("should handle unicode characters", () => {
        expect(native.patternMatch("你好", "你*")).toBe(true);
      });
    });
  });

  describe("batch processing", () => {
    describe("batch_process", () => {
      it("should uppercase multiple texts", async () => {
        const texts = ["hello", "world", "test"];
        const results = await native.batchProcess(texts, "uppercase");
        expect(results).toEqual(["HELLO", "WORLD", "TEST"]);
      });

      it("should lowercase multiple texts", async () => {
        const texts = ["HELLO", "WORLD", "TEST"];
        const results = await native.batchProcess(texts, "lowercase");
        expect(results).toEqual(["hello", "world", "test"]);
      });

      it("should reverse multiple texts", async () => {
        const texts = ["hello", "world"];
        const results = await native.batchProcess(texts, "reverse");
        expect(results).toEqual(["olleh", "dlrow"]);
      });

      it("should trim multiple texts", async () => {
        const texts = ["  hello  ", "  world  "];
        const results = await native.batchProcess(texts, "trim");
        expect(results).toEqual(["hello", "world"]);
      });

      it("should deduplicate multiple texts", async () => {
        const texts = ["aaabbb", "cccddd"];
        const results = await native.batchProcess(texts, "deduplicate");
        expect(results).toEqual(["abc", "cd"]);
      });

      it("should handle empty array", async () => {
        const results = await native.batchProcess([], "uppercase");
        expect(results).toEqual([]);
      });

      it("should throw error for unknown operation", async () => {
        await expect(native.batchProcess(["test"], "unknown")).rejects.toThrow();
      });

      it("should handle empty strings", async () => {
        const results = await native.batchProcess(["", "test"], "uppercase");
        expect(results).toEqual(["", "TEST"]);
      });

      it("should handle options parameter", async () => {
        const texts = ["hello", "world"];
        const results = await native.batchProcess(texts, "uppercase", {});
        expect(results).toEqual(["HELLO", "WORLD"]);
      });
    });
  });

  describe("data validation", () => {
    describe("validate_data", () => {
      it("should validate email format", () => {
        const rules = { email: "true" };
        expect(native.validateData("test@example.com", rules).is_valid).toBe(true);
        expect(native.validateData("invalid", rules).is_valid).toBe(false);
      });

      it("should validate URL format", () => {
        const rules = { url: "true" };
        expect(native.validateData("https://example.com", rules).is_valid).toBe(true);
        expect(native.validateData("http://test.com/path", rules).is_valid).toBe(true);
        expect(native.validateData("not a url", rules).is_valid).toBe(false);
      });

      it("should validate minimum length", () => {
        const rules = { min_length: "5" };
        expect(native.validateData("hello", rules).is_valid).toBe(true);
        expect(native.validateData("hi", rules).is_valid).toBe(false);
      });

      it("should validate maximum length", () => {
        const rules = { max_length: "5" };
        expect(native.validateData("hello", rules).is_valid).toBe(true);
        expect(native.validateData("hello world", rules).is_valid).toBe(false);
      });

      it("should validate regex pattern", () => {
        const rules = { pattern: "^\\d+$" };
        expect(native.validateData("12345", rules).is_valid).toBe(true);
        expect(native.validateData("abc", rules).is_valid).toBe(false);
      });

      it("should combine multiple validation rules", () => {
        const rules = {
          min_length: "5",
          max_length: "20",
          pattern: "^[a-zA-Z0-9]+$",
        };
        expect(native.validateData("Valid123", rules).is_valid).toBe(true);
        expect(native.validateData("no!", rules).is_valid).toBe(false);
      });

      it("should collect all validation errors", () => {
        const rules = {
          email: "true",
          min_length: "10",
        };
        const result = native.validateData("short", rules);
        expect(result.is_valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
      });

      it("should handle empty rules", () => {
        const result = native.validateData("test", {});
        expect(result.is_valid).toBe(true);
        expect(result.errors).toEqual([]);
      });
    });
  });

  describe("string similarity", () => {
    describe("levenshtein_distance", () => {
      it("should calculate distance for identical strings", () => {
        const distance = native.levenshteinDistance("hello", "hello");
        expect(distance).toBe(0);
      });

      it("should calculate distance for completely different strings", () => {
        const distance = native.levenshteinDistance("abc", "xyz");
        expect(distance).toBe(3);
      });

      it("should calculate distance for similar strings", () => {
        const distance = native.levenshteinDistance("kitten", "sitting");
        expect(distance).toBe(3);
      });

      it("should handle empty strings", () => {
        expect(native.levenshteinDistance("", "")).toBe(0);
        expect(native.levenshteinDistance("hello", "")).toBe(5);
        expect(native.levenshteinDistance("", "hello")).toBe(5);
      });

      it("should handle unicode characters", () => {
        const distance = native.levenshteinDistance("你好", "你好世界");
        expect(distance).toBeGreaterThan(0);
      });

      it("should be symmetric", () => {
        const d1 = native.levenshteinDistance("hello", "world");
        const d2 = native.levenshteinDistance("world", "hello");
        expect(d1).toBe(d2);
      });
    });
  });

  describe("find and replace", () => {
    describe("find_replace", () => {
      it("should replace simple string (non-regex)", () => {
        const result = native.findReplace("hello world", "world", "there", false);
        expect(result).toBe("hello there");
      });

      it("should replace all occurrences", () => {
        const result = native.findReplace("hello world hello", "hello", "hi", false);
        expect(result).toBe("hi world hi");
      });

      it("should use regex when flag is true", () => {
        const result = native.findReplace("hello123world456", "\\d+", "X", true);
        expect(result).toBe("helloXworldX");
      });

      it("should handle regex patterns", () => {
        const result = native.findReplace("hello   world", "\\s+", " ", true);
        expect(result).toBe("hello world");
      });

      it("should throw error for invalid regex", () => {
        expect(() => native.findReplace("test", "(?P<invalid", "X", true)).toThrow();
      });

      it("should handle no matches", () => {
        const result = native.findReplace("hello", "world", "there", false);
        expect(result).toBe("hello");
      });

      it("should handle empty string", () => {
        const result = native.findReplace("", "test", "replace", false);
        expect(result).toBe("");
      });

      it("should default to non-regex mode", () => {
        const result = native.findReplace("hello.world", ".", "!");
        expect(result).toBe("hello!world");
      });
    });
  });

  describe("data deduplication", () => {
    describe("deduplicate", () => {
      it("should remove duplicates (case sensitive)", () => {
        const items = ["a", "b", "a", "c", "b"];
        const result = native.deduplicate(items, true);
        expect(result).toEqual(["a", "b", "c"]);
      });

      it("should remove duplicates (case insensitive)", () => {
        const items = ["A", "b", "a", "B", "c"];
        const result = native.deduplicate(items, false);
        expect(result).toEqual(["A", "b", "c"]);
      });

      it("should preserve order", () => {
        const items = ["c", "a", "b", "a", "c"];
        const result = native.deduplicate(items, true);
        expect(result).toEqual(["c", "a", "b"]);
      });

      it("should handle empty array", () => {
        const result = native.deduplicate([], true);
        expect(result).toEqual([]);
      });

      it("should handle array with no duplicates", () => {
        const items = ["a", "b", "c"];
        const result = native.deduplicate(items, true);
        expect(result).toEqual(["a", "b", "c"]);
      });

      it("should handle array with all duplicates", () => {
        const items = ["a", "a", "a"];
        const result = native.deduplicate(items, true);
        expect(result).toEqual(["a"]);
      });

      it("should default to case sensitive", () => {
        const items = ["A", "a", "A"];
        const result = native.deduplicate(items);
        expect(result).toEqual(["A", "a"]);
      });
    });
  });
});
