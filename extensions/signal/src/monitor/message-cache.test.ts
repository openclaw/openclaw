import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheSignalMessage,
  clearSignalMessageCacheForTest,
  lookupSignalMessage,
} from "./message-cache.js";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

describe("signal message cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-17T00:00:00.000Z"));
    clearSignalMessageCacheForTest();
  });

  afterEach(() => {
    clearSignalMessageCacheForTest();
    vi.useRealTimers();
  });

  it("returns cached entries by timestamp", () => {
    cacheSignalMessage("1700000000000", "hello world", "Alice");

    const entry = lookupSignalMessage("1700000000000");
    expect(entry).toBeTruthy();
    expect(entry?.body).toBe("hello world");
    expect(entry?.sender).toBe("Alice");
    expect(entry?.timestamp).toBe(1700000000000);
    expect(entry?.cachedAt).toBe(Date.now());
  });

  it("returns undefined for unknown timestamps", () => {
    expect(lookupSignalMessage("999999")).toBeUndefined();
  });

  it("expires entries after the TTL window", () => {
    cacheSignalMessage("1700000000000", "stale soon");

    vi.advanceTimersByTime(SIX_HOURS_MS + 1);

    expect(lookupSignalMessage("1700000000000")).toBeUndefined();
  });

  it("evicts the oldest entry when cache exceeds max size", () => {
    for (let index = 0; index <= 2000; index += 1) {
      cacheSignalMessage(String(1700000000000 + index), `body-${index}`);
    }

    expect(lookupSignalMessage("1700000000000")).toBeUndefined();
    expect(lookupSignalMessage("1700000002000")?.body).toBe("body-2000");
  });
});
