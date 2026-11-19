import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelfChatCache } from "./self-chat-cache.js";

describe("SelfChatCache", () => {
  let cache: SelfChatCache;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T00:00:00Z"));
    cache = new SelfChatCache();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const directLookup = {
    accountId: "default",
    sender: "+15555550123",
    isGroup: false,
  } as const;
  const lookup = (text = "hello", createdAt = 123) => ({ ...directLookup, text, createdAt });

  it("matches repeated lookups for the same scope, timestamp, and text", () => {
    cache.remember(lookup("  hello\r\nworld  "));
    expect(cache.has(lookup("hello\nworld"))).toBe(true);
  });

  it("does not match reflected rows whose created_at differs by one second", () => {
    cache.remember({
      ...lookup("hello", 1_774_136_400_000),
      allowCreatedAtSkew: true,
    });
    expect(cache.has(lookup("hello", 1_774_136_401_000))).toBe(false);
  });

  it("expires entries after the ttl window", () => {
    cache.remember(lookup());
    vi.advanceTimersByTime(11_001);

    expect(cache.has(lookup())).toBe(false);
  });

  it("trims bursty inserts without requiring per-entry cleanup", () => {
    for (let i = 0; i < 2_000; i += 1) {
      cache.remember(lookup(`burst-${i}`, i));
    }

    vi.advanceTimersByTime(1_001);

    expect([0, 1487, 1488, 1999].map((i) => cache.has(lookup(`burst-${i}`, i)))).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  it("does not collide long texts that differ only in the middle", () => {
    const prefix = "a".repeat(256);
    const suffix = "b".repeat(256);
    const longTextA = `${prefix}${"x".repeat(300)}${suffix}`;
    const longTextB = `${prefix}${"y".repeat(300)}${suffix}`;

    cache.remember(lookup(longTextA));
    expect(cache.has(lookup(longTextA))).toBe(true);
    expect(cache.has(lookup(longTextB))).toBe(false);
  });
});
