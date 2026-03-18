import { writeFileSync, unlinkSync, mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadEmbeddingCache,
  isEmbeddingCacheLoaded,
  cosineSimilarity,
  findBestMatch,
  findBestTextMatch,
  clearEmbeddingCache,
  getEmbeddingCacheStats,
  ngramSet,
  jaccardSimilarity,
} from "../src/embedding-cache.ts";

// ---------------------------------------------------------------------------
// Helpers — temp files must be under ~/.openclaw/ to pass path validation
// ---------------------------------------------------------------------------

const testBaseDir = join(process.env.HOME || "", ".openclaw/test-emb-cache");
if (!existsSync(testBaseDir)) {
  mkdirSync(testBaseDir, { recursive: true });
}

let tempDir: string;
let tempFile: string;

function writeTempCache(data: unknown): string {
  tempFile = join(tempDir, `cache-${Date.now()}.json`);
  writeFileSync(tempFile, JSON.stringify(data));
  return tempFile;
}

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [1, 2, 3];
    expect(Math.abs(cosineSimilarity(v, v) - 1.0) < 1e-10).toBe(true);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-10).toBe(true);
  });

  it("returns -1 for opposite vectors", () => {
    expect(Math.abs(cosineSimilarity([1, 0], [-1, 0]) - -1.0) < 1e-10).toBe(true);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for zero vectors", () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it("computes correctly for arbitrary vectors", () => {
    // cos([1,2,3], [4,5,6]) = 32 / (sqrt(14) * sqrt(77))
    const expected = 32 / (Math.sqrt(14) * Math.sqrt(77));
    expect(Math.abs(cosineSimilarity([1, 2, 3], [4, 5, 6]) - expected) < 1e-10).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ngramSet and jaccardSimilarity
// ---------------------------------------------------------------------------

describe("ngramSet", () => {
  it("produces correct trigrams", () => {
    const grams = ngramSet("hello", 3);
    expect([...grams].toSorted()).toEqual(["ell", "hel", "llo"]);
  });

  it("returns empty set for text shorter than n", () => {
    const grams = ngramSet("ab", 3);
    expect(grams.size).toBe(0);
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1 for identical sets", () => {
    const s = new Set(["a", "b", "c"]);
    expect(jaccardSimilarity(s, s)).toBe(1);
  });

  it("returns 0 for disjoint sets", () => {
    const a = new Set(["a", "b"]);
    const b = new Set(["c", "d"]);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it("returns 0 for two empty sets", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it("computes partial overlap correctly", () => {
    const a = new Set(["a", "b", "c"]);
    const b = new Set(["b", "c", "d"]);
    // intersection=2, union=4 -> 0.5
    expect(jaccardSimilarity(a, b)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// loadEmbeddingCache / isEmbeddingCacheLoaded / clearEmbeddingCache / stats
// ---------------------------------------------------------------------------

describe("loadEmbeddingCache", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(testBaseDir, "emb-test-"));
    clearEmbeddingCache();
  });

  afterEach(() => {
    clearEmbeddingCache();
    try {
      if (tempFile) {
        unlinkSync(tempFile);
      }
    } catch {
      /* ignore */
    }
  });

  it("returns false for empty path", () => {
    expect(loadEmbeddingCache("")).toBe(false);
    expect(isEmbeddingCacheLoaded()).toBe(false);
  });

  it("returns false for non-existent path", () => {
    expect(loadEmbeddingCache("/tmp/nonexistent-cache-abc123.json")).toBe(false);
  });

  it("returns false for invalid JSON", () => {
    const path = writeTempCache("not json {{{}");
    writeFileSync(path, "not json {{{}", "utf-8");
    expect(loadEmbeddingCache(path)).toBe(false);
  });

  it("returns false for missing entries array", () => {
    const path = writeTempCache({ dimension: 3 });
    expect(loadEmbeddingCache(path)).toBe(false);
  });

  it("returns false for missing dimension", () => {
    const path = writeTempCache({ entries: [] });
    expect(loadEmbeddingCache(path)).toBe(false);
  });

  it("loads valid cache successfully", () => {
    const path = writeTempCache({
      dimension: 3,
      entries: [
        { text: "hello", kind: "chat", vector: [1, 0, 0] },
        { text: "run test", kind: "run", vector: [0, 1, 0] },
      ],
    });
    expect(loadEmbeddingCache(path)).toBe(true);
    expect(isEmbeddingCacheLoaded()).toBe(true);
  });

  it("getEmbeddingCacheStats returns correct info after load", () => {
    const path = writeTempCache({
      dimension: 4,
      entries: [{ text: "a", kind: "chat", vector: [1, 0, 0, 0] }],
    });
    loadEmbeddingCache(path);
    const stats = getEmbeddingCacheStats();
    expect(stats.loaded).toBe(true);
    expect(stats.entryCount).toBe(1);
    expect(stats.dimension).toBe(4);
  });

  it("getEmbeddingCacheStats returns empty when not loaded", () => {
    const stats = getEmbeddingCacheStats();
    expect(stats.loaded).toBe(false);
    expect(stats.entryCount).toBe(0);
    expect(stats.dimension).toBe(0);
  });

  it("clearEmbeddingCache resets state", () => {
    const path = writeTempCache({
      dimension: 3,
      entries: [{ text: "a", kind: "chat", vector: [1, 0, 0] }],
    });
    loadEmbeddingCache(path);
    expect(isEmbeddingCacheLoaded()).toBe(true);
    clearEmbeddingCache();
    expect(isEmbeddingCacheLoaded()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findBestMatch (vector-based)
// ---------------------------------------------------------------------------

describe("findBestMatch", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(testBaseDir, "emb-test-"));
    clearEmbeddingCache();
  });

  afterEach(() => {
    clearEmbeddingCache();
    try {
      if (tempFile) {
        unlinkSync(tempFile);
      }
    } catch {
      /* ignore */
    }
  });

  it("returns null when cache is not loaded", () => {
    expect(findBestMatch([1, 0, 0])).toBeNull();
  });

  it("returns null when query dimension mismatches", () => {
    const path = writeTempCache({
      dimension: 3,
      entries: [{ text: "a", kind: "chat", vector: [1, 0, 0] }],
    });
    loadEmbeddingCache(path);
    expect(findBestMatch([1, 0])).toBeNull();
  });

  it("returns null when similarity is below threshold (0.85)", () => {
    const path = writeTempCache({
      dimension: 3,
      entries: [{ text: "a", kind: "chat", vector: [1, 0, 0] }],
    });
    loadEmbeddingCache(path);
    // [0, 1, 0] is orthogonal to [1, 0, 0] -> similarity = 0
    expect(findBestMatch([0, 1, 0])).toBeNull();
  });

  it("returns match when similarity exceeds threshold", () => {
    const path = writeTempCache({
      dimension: 3,
      entries: [
        { text: "hello", kind: "chat", vector: [1, 0, 0] },
        { text: "run test", kind: "run", vector: [0, 1, 0] },
      ],
    });
    loadEmbeddingCache(path);
    // Query very close to [1, 0, 0]
    const match = findBestMatch([0.99, 0.01, 0.01]);
    expect(match).not.toBeNull();
    expect(match!.kind).toBe("chat");
    expect(match!.matchedText).toBe("hello");
    expect(match!.similarity >= 0.85).toBe(true);
  });

  it("finds the closest entry among multiple", () => {
    const path = writeTempCache({
      dimension: 2,
      entries: [
        { text: "search files", kind: "search", vector: [1, 0] },
        { text: "install pkg", kind: "install", vector: [0, 1] },
      ],
    });
    loadEmbeddingCache(path);
    const match = findBestMatch([0.98, 0.05]);
    expect(match).not.toBeNull();
    expect(match!.kind).toBe("search");
  });
});

// ---------------------------------------------------------------------------
// findBestTextMatch (n-gram based)
// ---------------------------------------------------------------------------

describe("findBestTextMatch", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(testBaseDir, "emb-test-"));
    clearEmbeddingCache();
  });

  afterEach(() => {
    clearEmbeddingCache();
    try {
      if (tempFile) {
        unlinkSync(tempFile);
      }
    } catch {
      /* ignore */
    }
  });

  it("returns null when cache is not loaded", () => {
    expect(findBestTextMatch("hello")).toBeNull();
  });

  it("returns null when no entry exceeds threshold", () => {
    const path = writeTempCache({
      dimension: 1,
      entries: [{ text: "completely unrelated text here", kind: "chat", vector: [1] }],
    });
    loadEmbeddingCache(path);
    expect(findBestTextMatch("xyz123", 0.9)).toBeNull();
  });

  it("matches similar text above threshold", () => {
    const path = writeTempCache({
      dimension: 1,
      entries: [
        { text: "npm install typescript", kind: "install", vector: [1] },
        { text: "run the unit tests", kind: "run", vector: [1] },
      ],
    });
    loadEmbeddingCache(path);
    const match = findBestTextMatch("npm install lodash", 0.3);
    expect(match).not.toBeNull();
    expect(match!.kind).toBe("install");
  });

  it("picks the best match among multiple entries", () => {
    const path = writeTempCache({
      dimension: 1,
      entries: [
        { text: "grep error log", kind: "search", vector: [1] },
        { text: "run the tests", kind: "run", vector: [1] },
        { text: "debug this crash", kind: "debug", vector: [1] },
      ],
    });
    loadEmbeddingCache(path);
    const match = findBestTextMatch("grep error output", 0.2);
    expect(match).not.toBeNull();
    expect(match!.kind).toBe("search");
  });

  it("is case-insensitive", () => {
    const path = writeTempCache({
      dimension: 1,
      entries: [{ text: "NPM INSTALL REACT", kind: "install", vector: [1] }],
    });
    loadEmbeddingCache(path);
    const match = findBestTextMatch("npm install react", 0.3);
    expect(match).not.toBeNull();
    expect(match!.kind).toBe("install");
  });
});
