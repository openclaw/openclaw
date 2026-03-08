import { describe, expect, it } from "vitest";
import {
  buildDeliveredTextHash,
  isRecentlyDelivered,
  normalizeTextForComparison,
  recordDeliveredText,
  type RecentDeliveredEntry,
} from "./messaging-dedupe.js";

describe("normalizeTextForComparison", () => {
  it("lowercases and trims", () => {
    expect(normalizeTextForComparison("  Hello World  ")).toBe("hello world");
  });

  it("collapses whitespace", () => {
    expect(normalizeTextForComparison("hello   world")).toBe("hello world");
  });
});

describe("cross-turn dedup", () => {
  describe("buildDeliveredTextHash", () => {
    it("returns normalized prefix up to 200 chars", () => {
      const hash = buildDeliveredTextHash("Hello World!");
      expect(hash).toBe("hello world!");
    });

    it("includes length and full-text hash for strings over 200 chars", () => {
      const long = "a".repeat(300);
      const hash = buildDeliveredTextHash(long);
      expect(hash).toContain("|300|");
      expect(hash.startsWith("a".repeat(200))).toBe(true);
    });

    it("produces different hashes for texts with same prefix but different tails", () => {
      const base = "x".repeat(200);
      const textA = base + " ending alpha with more content here";
      const textB = base + " ending beta with different content";
      expect(buildDeliveredTextHash(textA)).not.toBe(buildDeliveredTextHash(textB));
    });

    it("returns empty for very short text", () => {
      expect(buildDeliveredTextHash("hi")).toBe("hi");
    });
  });

  describe("isRecentlyDelivered", () => {
    it("returns false for empty cache", () => {
      expect(isRecentlyDelivered("Hello world test message", [])).toBe(false);
    });

    it("returns true when text was recently recorded", () => {
      const cache: RecentDeliveredEntry[] = [];
      const now = Date.now();
      recordDeliveredText("Hello world test message", cache, now);
      expect(isRecentlyDelivered("Hello world test message", cache, now + 1000)).toBe(true);
    });

    it("returns false after TTL expires", () => {
      const cache: RecentDeliveredEntry[] = [];
      const now = Date.now();
      recordDeliveredText("Hello world test message", cache, now);
      // 1 hour + 1ms later
      expect(isRecentlyDelivered("Hello world test message", cache, now + 3_600_001)).toBe(false);
    });

    it("returns false for text shorter than MIN_DUPLICATE_TEXT_LENGTH", () => {
      const cache: RecentDeliveredEntry[] = [];
      recordDeliveredText("short", cache);
      expect(isRecentlyDelivered("short", cache)).toBe(false);
    });

    it("detects duplicates with different whitespace/casing", () => {
      const cache: RecentDeliveredEntry[] = [];
      const now = Date.now();
      recordDeliveredText("  Hello   World  Test  Message  ", cache, now);
      expect(isRecentlyDelivered("hello world test message", cache, now)).toBe(true);
    });
  });

  describe("recordDeliveredText", () => {
    it("evicts expired entries on record", () => {
      const cache: RecentDeliveredEntry[] = [];
      const now = Date.now();
      recordDeliveredText("First message that is long enough", cache, now);
      // Record second much later (> TTL)
      recordDeliveredText("Second message that is long enough", cache, now + 3_700_000);
      // First should be evicted
      expect(cache.length).toBe(1);
      expect(cache[0].hash).toContain("second");
    });

    it("caps at RECENT_DELIVERED_MAX entries", () => {
      const cache: RecentDeliveredEntry[] = [];
      const now = Date.now();
      for (let i = 0; i < 25; i++) {
        recordDeliveredText(`Unique message number ${i} with enough length`, cache, now + i);
      }
      expect(cache.length).toBe(20);
    });

    it("updates timestamp for duplicate hash instead of adding", () => {
      const cache: RecentDeliveredEntry[] = [];
      const now = Date.now();
      recordDeliveredText("Same message repeated in session", cache, now);
      recordDeliveredText("Same message repeated in session", cache, now + 5000);
      expect(cache.length).toBe(1);
      expect(cache[0].timestamp).toBe(now + 5000);
    });
  });
});
