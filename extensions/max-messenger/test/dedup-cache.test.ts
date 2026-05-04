/**
 * Unit tests for the dedup cache (Phase 1B.2). Pure module — no fake-MAX
 * server involved. Tests use an injectable `now` so TTL semantics are
 * deterministic and the suite stays fast.
 */
import { describe, expect, it } from "vitest";
import { createDedupCache } from "../src/polling/dedup-cache.js";

describe("dedup-cache", () => {
  it("rejects nonsense capacity / ttlMs", () => {
    expect(() => createDedupCache({ capacity: 0 })).toThrowError(/capacity/iu);
    expect(() => createDedupCache({ ttlMs: 0 })).toThrowError(/ttlMs/iu);
  });

  it("returns false for keys never added", () => {
    const cache = createDedupCache({ capacity: 4, ttlMs: 10_000 });
    expect(cache.has("msg:1")).toBe(false);
  });

  it("returns true for an added key within TTL", () => {
    const cache = createDedupCache({ capacity: 4, ttlMs: 10_000 });
    cache.add("msg:1");
    expect(cache.has("msg:1")).toBe(true);
    expect(cache.size()).toBe(1);
  });

  it("expires entries past TTL on the next read", () => {
    let now = 1_000;
    const cache = createDedupCache({ capacity: 4, ttlMs: 1_000, now: () => now });
    cache.add("msg:expire");
    expect(cache.has("msg:expire")).toBe(true);
    now += 1_001;
    expect(cache.has("msg:expire")).toBe(false);
    expect(cache.size()).toBe(0);
  });

  it("evicts the oldest entry once capacity is exceeded", () => {
    const cache = createDedupCache({ capacity: 3, ttlMs: 60_000 });
    cache.add("a");
    cache.add("b");
    cache.add("c");
    cache.add("d"); // forces eviction of "a"
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
    expect(cache.has("d")).toBe(true);
    expect(cache.size()).toBe(3);
  });

  it("re-inserting an existing key bumps it to the newest position (LRU)", () => {
    const cache = createDedupCache({ capacity: 3, ttlMs: 60_000 });
    cache.add("a");
    cache.add("b");
    cache.add("c");
    // Touch "a" — it should move to the newest slot, so the next add evicts "b".
    cache.add("a");
    cache.add("d");
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
    expect(cache.has("d")).toBe(true);
  });

  it("does not refresh insertion order on `has`", () => {
    const cache = createDedupCache({ capacity: 3, ttlMs: 60_000 });
    cache.add("a");
    cache.add("b");
    cache.add("c");
    // Reads should not promote "a" out of eviction range.
    expect(cache.has("a")).toBe(true);
    cache.add("d");
    expect(cache.has("a")).toBe(false);
  });

  it("clear() removes every entry without resetting capacity / TTL", () => {
    const cache = createDedupCache({ capacity: 2, ttlMs: 60_000 });
    cache.add("a");
    cache.add("b");
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.has("a")).toBe(false);
    cache.add("c");
    cache.add("d");
    cache.add("e"); // capacity still 2 → evicts "c"
    expect(cache.has("c")).toBe(false);
    expect(cache.has("d")).toBe(true);
    expect(cache.has("e")).toBe(true);
  });

  it("respects the documented Phase 1B defaults (capacity 10000, TTL 1h)", () => {
    // Sanity check that the production defaults match plan §8 row 16. We don't
    // exhaustively walk 10001 entries — just confirm the default constants are
    // stable so plan drift gets caught early.
    let now = 0;
    const cache = createDedupCache({ now: () => now });
    cache.add("k");
    now += 60 * 60 * 1000 - 1; // just under 1h
    expect(cache.has("k")).toBe(true);
    now += 2;
    expect(cache.has("k")).toBe(false);
  });
});
