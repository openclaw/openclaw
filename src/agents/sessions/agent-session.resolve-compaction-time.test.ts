// Regression tests for resolveCompactionTime — the malformed-boundary guard
// that prevents stale pre-compaction messages from re-triggering compaction.
// Imported from compaction-time.ts (an internal module not re-exported from
// the public plugin SDK) to avoid adding it to the SDK surface budget.
import { describe, expect, it } from "vitest";
import { resolveCompactionTime } from "./compaction-time.js";

describe("resolveCompactionTime", () => {
  it("returns epoch ms for a valid ISO timestamp", () => {
    const time = resolveCompactionTime({ timestamp: "2026-07-03T12:00:00.000Z" });
    expect(time).toBeTypeOf("number");
    expect(time).toBeGreaterThan(0);
  });

  it("returns undefined for null entry (no compaction boundary)", () => {
    expect(resolveCompactionTime(null)).toBeUndefined();
  });

  it("returns undefined when the timestamp is an empty string", () => {
    expect(resolveCompactionTime({ timestamp: "" })).toBeUndefined();
  });

  it("returns undefined when the timestamp is a non-date string", () => {
    expect(resolveCompactionTime({ timestamp: "not-a-date" })).toBeUndefined();
    expect(resolveCompactionTime({ timestamp: "garbage" })).toBeUndefined();
  });

  it("returns undefined when the timestamp is whitespace only", () => {
    expect(resolveCompactionTime({ timestamp: "   " })).toBeUndefined();
  });

  it("round-trips a known timestamp correctly", () => {
    const iso = "2026-01-15T08:30:00.000Z";
    const time = resolveCompactionTime({ timestamp: iso });
    expect(time).toBe(new Date(iso).getTime());
  });

  it("returns undefined for timestamp strings that produce NaN in Date", () => {
    const nanProducing = ["", "invalid", "undefined", "null", "true", "1234567890"];
    for (const ts of nanProducing) {
      expect(resolveCompactionTime({ timestamp: ts })).toBeUndefined();
    }
  });

  it("handles timestamps with timezone offsets", () => {
    const t1 = resolveCompactionTime({ timestamp: "2026-07-03T12:00:00+08:00" });
    const t2 = resolveCompactionTime({ timestamp: "2026-07-03T04:00:00.000Z" });
    expect(t1).toBe(t2);
  });

  it("returns undefined when the parsed timestamp is not finite", () => {
    // A very large finite mantissa can overflow to Infinity when parsed.
    // "1e309 days" is astronomically beyond JS Date range and must be rejected.
    const huge = "1" + "0".repeat(309);
    expect(resolveCompactionTime({ timestamp: huge })).toBeUndefined();
  });

  it("returns undefined when the parsed timestamp is epoch or negative", () => {
    // Epoch-zero represents Jan 1 1970 UTC and is not a valid compaction
    // timestamp in practice; reject it to guard against data corruption.
    expect(resolveCompactionTime({ timestamp: "1970-01-01T00:00:00.000Z" })).toBeUndefined();
  });
});
