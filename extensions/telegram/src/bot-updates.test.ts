import { describe, expect, it, vi } from "vitest";
import { createTelegramUpdateIdDedupe, telegramUpdateIdDedupeKey } from "./bot-updates.js";

describe("createTelegramUpdateIdDedupe", () => {
  it("marks update_ids as seen only after the first check", () => {
    const cache = createTelegramUpdateIdDedupe();
    const key = telegramUpdateIdDedupeKey(42);
    expect(cache.peek(key)).toBe(false);
    expect(cache.check(key)).toBe(false);
    expect(cache.peek(key)).toBe(true);
    expect(cache.check(key)).toBe(true);
  });

  it("expires entries after the 5-minute TTL", () => {
    const cache = createTelegramUpdateIdDedupe();
    const key = telegramUpdateIdDedupeKey(7);
    const base = 1_000_000_000;
    expect(cache.check(key, base)).toBe(false);
    expect(cache.peek(key, base + 60_000)).toBe(true);
    // Just before 5 minutes → still cached.
    expect(cache.peek(key, base + 5 * 60_000 - 1)).toBe(true);
    // At 5 minutes the entry has aged out.
    expect(cache.peek(key, base + 5 * 60_000)).toBe(false);
    // check() after expiry treats the update_id as unseen again.
    expect(cache.check(key, base + 5 * 60_000 + 1)).toBe(false);
  });

  it("evicts the oldest entry once the 512-entry cap is exceeded", () => {
    const cache = createTelegramUpdateIdDedupe();
    const now = 1_000_000_000;
    for (let i = 0; i < 512; i += 1) {
      cache.check(telegramUpdateIdDedupeKey(i), now + i);
    }
    expect(cache.size()).toBe(512);
    // Inserting one more evicts the least-recently-used entry (id=0).
    cache.check(telegramUpdateIdDedupeKey(9999), now + 1_000);
    expect(cache.size()).toBe(512);
    expect(cache.peek(telegramUpdateIdDedupeKey(0), now + 1_000)).toBe(false);
    expect(cache.peek(telegramUpdateIdDedupeKey(511), now + 1_000)).toBe(true);
    expect(cache.peek(telegramUpdateIdDedupeKey(9999), now + 1_000)).toBe(true);
  });

  it("refreshes recency on peek-free check and evicts the true LRU entry", () => {
    const cache = createTelegramUpdateIdDedupe();
    const now = 1_000_000_000;
    for (let i = 0; i < 512; i += 1) {
      cache.check(telegramUpdateIdDedupeKey(i), now + i);
    }
    // Touch id=0 so id=1 becomes the least-recently-used entry.
    cache.check(telegramUpdateIdDedupeKey(0), now + 10_000);
    cache.check(telegramUpdateIdDedupeKey(9999), now + 20_000);
    expect(cache.peek(telegramUpdateIdDedupeKey(0), now + 20_000)).toBe(true);
    expect(cache.peek(telegramUpdateIdDedupeKey(1), now + 20_000)).toBe(false);
  });

  it("keys are namespaced so they cannot collide with other dedupe keys", () => {
    expect(telegramUpdateIdDedupeKey(1)).toBe("update_id:1");
    const cache = createTelegramUpdateIdDedupe();
    cache.check("update:1");
    expect(cache.peek(telegramUpdateIdDedupeKey(1))).toBe(false);
  });

  it("peek is non-mutating — does not extend TTL or touch recency", () => {
    const cache = createTelegramUpdateIdDedupe();
    const key = telegramUpdateIdDedupeKey(1);
    const base = 1_000_000_000;
    cache.check(key, base);
    const peekSpy = vi.fn(() => cache.peek(key, base + 60_000));
    peekSpy();
    peekSpy();
    // Entry still expires 5 minutes after the original check, not after peeks.
    expect(cache.peek(key, base + 5 * 60_000)).toBe(false);
  });
});
