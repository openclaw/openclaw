import { describe, expect, test } from "vitest";
import { createDedupeCache } from "./monitor-helpers.js";

describe("monitor-helpers createDedupeCache", () => {
  test("exports a working dedupe cache function", () => {
    expect(typeof createDedupeCache).toBe("function");

    const cache = createDedupeCache({ ttlMs: 60_000, maxSize: 10 });
    expect(cache.check("abc", 1)).toBe(false);
    expect(cache.check("abc", 2)).toBe(true);
    expect(cache.check("def", 3)).toBe(false);
  });
});
