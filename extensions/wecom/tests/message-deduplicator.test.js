/**
 * Tests for MessageDeduplicator and TTLCache (utils.js)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MessageDeduplicator, TTLCache } from "../utils.js";

describe("TTLCache — basic operations", () => {
  it("stores and retrieves a value within TTL", () => {
    const cache = new TTLCache({ ttl: 5000 });
    cache.set("key1", "value1");
    assert.equal(cache.get("key1"), "value1");
    cache.destroy();
  });

  it("returns undefined for missing keys", () => {
    const cache = new TTLCache({ ttl: 5000 });
    assert.equal(cache.get("nonexistent"), undefined);
    cache.destroy();
  });

  it("has() returns true for present keys", () => {
    const cache = new TTLCache({ ttl: 5000 });
    cache.set("k", "v");
    assert.equal(cache.has("k"), true);
    cache.destroy();
  });

  it("has() returns false for absent keys", () => {
    const cache = new TTLCache({ ttl: 5000 });
    assert.equal(cache.has("missing"), false);
    cache.destroy();
  });

  it("delete removes a key", () => {
    const cache = new TTLCache({ ttl: 5000 });
    cache.set("k", "v");
    cache.delete("k");
    assert.equal(cache.has("k"), false);
    cache.destroy();
  });

  it("clear removes all keys", () => {
    const cache = new TTLCache({ ttl: 5000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    assert.equal(cache.size(), 0);
    cache.destroy();
  });

  it("expires a key after its TTL", async () => {
    const cache = new TTLCache({ ttl: 50, checkPeriod: 10000 });
    cache.set("expiring", "value");
    assert.equal(cache.has("expiring"), true);
    // Wait for expiry.
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(cache.has("expiring"), false);
    cache.destroy();
  });

  it("per-key TTL overrides default TTL", async () => {
    const cache = new TTLCache({ ttl: 5000, checkPeriod: 10000 });
    cache.set("shortlived", "v", 50); // expire in 50ms
    cache.set("longlived", "v", 5000);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(cache.has("shortlived"), false);
    assert.equal(cache.has("longlived"), true);
    cache.destroy();
  });

  it("size() counts only non-expired entries", async () => {
    const cache = new TTLCache({ ttl: 5000, checkPeriod: 10000 });
    cache.set("a", 1, 50);
    cache.set("b", 2, 5000);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(cache.size(), 1);
    cache.destroy();
  });
});

describe("MessageDeduplicator — dedup logic", () => {
  it("first call with a new msgId returns false (not duplicate)", () => {
    const dedup = new MessageDeduplicator();
    assert.equal(dedup.isDuplicate("msg-001"), false);
    dedup.seen.destroy();
  });

  it("second call with same msgId returns true (duplicate)", () => {
    const dedup = new MessageDeduplicator();
    dedup.isDuplicate("msg-002");
    assert.equal(dedup.isDuplicate("msg-002"), true);
    dedup.seen.destroy();
  });

  it("different msgIds are not duplicates of each other", () => {
    const dedup = new MessageDeduplicator();
    assert.equal(dedup.isDuplicate("msg-A"), false);
    assert.equal(dedup.isDuplicate("msg-B"), false);
    assert.equal(dedup.isDuplicate("msg-C"), false);
    dedup.seen.destroy();
  });

  it("markAsSeen marks a msgId as seen", () => {
    const dedup = new MessageDeduplicator();
    dedup.markAsSeen("pre-marked");
    assert.equal(dedup.isDuplicate("pre-marked"), true);
    dedup.seen.destroy();
  });

  it("entries pass again after TTL expires (using short TTL override)", async () => {
    const dedup = new MessageDeduplicator();
    // Override the internal TTL cache with a very short one.
    dedup.seen.destroy();
    dedup.seen = new TTLCache({ ttl: 60, checkPeriod: 10000 });

    assert.equal(dedup.isDuplicate("ttl-msg"), false);
    assert.equal(dedup.isDuplicate("ttl-msg"), true); // duplicate within window

    await new Promise((r) => setTimeout(r, 100)); // wait for expiry

    // After TTL, it is no longer considered a duplicate.
    assert.equal(dedup.isDuplicate("ttl-msg"), false);
    dedup.seen.destroy();
  });

  it("handles many unique messages without false positives", () => {
    const dedup = new MessageDeduplicator();
    for (let i = 0; i < 100; i++) {
      assert.equal(dedup.isDuplicate(`unique-${i}`), false);
    }
    // All seen now.
    for (let i = 0; i < 100; i++) {
      assert.equal(dedup.isDuplicate(`unique-${i}`), true);
    }
    dedup.seen.destroy();
  });
});
