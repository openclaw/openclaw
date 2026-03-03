import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NewsStore } from "./news-store.js";
import type { KolNewsItem } from "./grok-client.js";

function makeItem(overrides: Partial<KolNewsItem> = {}): KolNewsItem {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    source: "x_search",
    handle: "testuser",
    title: "Test News",
    summary: "A test news item",
    score: 7,
    category: "crypto",
    symbols: ["BTC"],
    sentiment: "bullish",
    sourceUrls: ["https://x.com/test/1"],
    scannedAt: new Date().toISOString(),
    pushed: false,
    ...overrides,
  };
}

describe("NewsStore", () => {
  let store: NewsStore;
  let dbPath: string;
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `fin-info-feed-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    dbPath = join(testDir, "test-news.sqlite");
    store = new NewsStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ── News Items ───────────────────────────────────────────────

  describe("insertItems", () => {
    it("inserts items and returns count", () => {
      const items = [makeItem({ id: "n1" }), makeItem({ id: "n2" })];
      const inserted = store.insertItems(items);
      expect(inserted).toBe(2);
    });

    it("ignores duplicate IDs", () => {
      const item = makeItem({ id: "dup-1" });
      store.insertItems([item]);
      const inserted = store.insertItems([item]);
      expect(inserted).toBe(0);
    });
  });

  describe("getRecent", () => {
    it("returns items ordered by scanned_at DESC", () => {
      const old = makeItem({ id: "old", scannedAt: "2026-03-01T00:00:00Z" });
      const recent = makeItem({ id: "new", scannedAt: "2026-03-02T00:00:00Z" });
      store.insertItems([old, recent]);

      const items = store.getRecent(10);
      expect(items).toHaveLength(2);
      expect(items[0]!.id).toBe("new");
    });

    it("respects limit", () => {
      store.insertItems([makeItem({ id: "a" }), makeItem({ id: "b" }), makeItem({ id: "c" })]);
      const items = store.getRecent(2);
      expect(items).toHaveLength(2);
    });
  });

  describe("getUrgentUnpushed", () => {
    it("returns only unpushed items above threshold", () => {
      store.insertItems([
        makeItem({ id: "low", score: 5, pushed: false }),
        makeItem({ id: "high", score: 9, pushed: false }),
        makeItem({ id: "pushed", score: 10, pushed: true }),
      ]);

      // pushed=true items are stored with pushed=1 in DB
      // But our insert uses pushed: false → 0. Need to manually mark pushed.
      store.markPushed(["pushed"]);

      const items = store.getUrgentUnpushed(9);
      expect(items).toHaveLength(1);
      expect(items[0]!.id).toBe("high");
    });
  });

  describe("getItemsSince", () => {
    it("filters by time and minimum score", () => {
      store.insertItems([
        makeItem({ id: "old-high", scannedAt: "2026-01-01T00:00:00Z", score: 9 }),
        makeItem({ id: "new-low", scannedAt: "2026-03-02T00:00:00Z", score: 3 }),
        makeItem({ id: "new-high", scannedAt: "2026-03-02T00:00:00Z", score: 8 }),
      ]);

      const items = store.getItemsSince("2026-03-01T00:00:00Z", 5);
      expect(items).toHaveLength(1);
      expect(items[0]!.id).toBe("new-high");
    });
  });

  describe("markPushed", () => {
    it("marks items as pushed with timestamp", () => {
      store.insertItems([makeItem({ id: "p1" }), makeItem({ id: "p2" })]);
      store.markPushed(["p1"]);

      const items = store.getUrgentUnpushed(1);
      const ids = items.map((i) => i.id);
      expect(ids).not.toContain("p1");
      expect(ids).toContain("p2");
    });

    it("handles empty array gracefully", () => {
      expect(() => store.markPushed([])).not.toThrow();
    });
  });

  describe("markDigestIncluded", () => {
    it("does not throw for valid ids", () => {
      store.insertItems([makeItem({ id: "d1" })]);
      expect(() => store.markDigestIncluded(["d1"])).not.toThrow();
    });
  });

  describe("getStats", () => {
    it("returns aggregated statistics", () => {
      store.insertItems([
        makeItem({ id: "s1", handle: "alice", score: 8, scannedAt: "2026-03-02T00:00:00Z" }),
        makeItem({ id: "s2", handle: "alice", score: 6, scannedAt: "2026-03-02T01:00:00Z" }),
        makeItem({ id: "s3", handle: "bob", score: 9, scannedAt: "2026-03-02T02:00:00Z" }),
      ]);

      const stats = store.getStats("2026-03-01T00:00:00Z");
      expect(stats.totalItems).toBe(3);
      expect(stats.unpushedCount).toBe(3);
      expect(stats.avgScore).toBeCloseTo(7.7, 0);
      expect(stats.topHandles[0]!.handle).toBe("alice");
      expect(stats.topHandles[0]!.count).toBe(2);
    });
  });

  // ── Subscriptions ────────────────────────────────────────────

  describe("subscriptions", () => {
    it("adds and lists active subscriptions", () => {
      store.addSubscription("@ElonMusk", "high");
      store.addSubscription("CryptoHayes", "medium");

      const subs = store.getActiveSubscriptions();
      expect(subs).toHaveLength(2);
      expect(subs[0]!.handle).toBe("cryptohayes"); // sorted, lowercased
      expect(subs[1]!.handle).toBe("elonmusk");
      expect(subs[1]!.priority).toBe("high");
    });

    it("re-activates removed subscription on add", () => {
      store.addSubscription("test");
      store.removeSubscription("test");
      expect(store.getActiveSubscriptions()).toHaveLength(0);

      store.addSubscription("test", "critical");
      const subs = store.getActiveSubscriptions();
      expect(subs).toHaveLength(1);
      expect(subs[0]!.priority).toBe("critical");
    });

    it("removeSubscription sets active=0", () => {
      store.addSubscription("alice");
      store.addSubscription("bob");
      store.removeSubscription("alice");

      const subs = store.getActiveSubscriptions();
      expect(subs).toHaveLength(1);
      expect(subs[0]!.handle).toBe("bob");
    });
  });

  // ── Scan History ─────────────────────────────────────────────

  describe("scan history", () => {
    it("tracks scan lifecycle: start → complete", () => {
      const scanId = store.startScan();
      expect(scanId).toBeGreaterThan(0);

      store.completeScan(scanId, 5);
      const lastTime = store.getLastScanTime();
      expect(lastTime).toBeTruthy();
    });

    it("tracks failed scans", () => {
      const scanId = store.startScan();
      store.failScan(scanId, "API timeout");

      // Failed scans don't count as last scan time
      const scanId2 = store.startScan();
      store.completeScan(scanId2, 0);
      const lastTime = store.getLastScanTime();
      expect(lastTime).toBeTruthy();
    });

    it("returns null when no scans completed", () => {
      expect(store.getLastScanTime()).toBeNull();
    });
  });
});
