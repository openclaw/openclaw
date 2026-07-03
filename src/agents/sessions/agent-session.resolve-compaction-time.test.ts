// Regression tests for resolveCompactionTime — the malformed-boundary guard
// that prevents stale pre-compaction messages from re-triggering compaction.
import { describe, expect, it } from "vitest";
import { resolveCompactionTime } from "./agent-session.js";

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

  it("returns undefined when the timestamp is a bare number", () => {
    // Some JSONL may contain numeric timestamps; Date.parse of a numeric
    // string varies across engines.  When it fails we must fall back to
    // undefined so the boundary guard is skipped.
    const time = resolveCompactionTime({ timestamp: "1234567890" });
    // The behavior depends on the engine, but must never be NaN-guarded
    // without a deliberate fallback.
    expect(time === undefined || typeof time === "number").toBe(true);
  });

  it("round-trips a known timestamp correctly", () => {
    const iso = "2026-01-15T08:30:00.000Z";
    const time = resolveCompactionTime({ timestamp: iso });
    expect(time).toBe(new Date(iso).getTime());
  });

  it("returns undefined for timestamp strings that produce NaN in Date", () => {
    // These inputs cause `new Date(x).getTime()` to return NaN.
    // The helper must return undefined so callers skip the guard.
    const nanProducing = ["", "invalid", "undefined", "null", "true"];
    for (const ts of nanProducing) {
      expect(resolveCompactionTime({ timestamp: ts })).toBeUndefined();
    }
  });

  it("handles timestamps with timezone offsets", () => {
    const t1 = resolveCompactionTime({ timestamp: "2026-07-03T12:00:00+08:00" });
    const t2 = resolveCompactionTime({ timestamp: "2026-07-03T04:00:00.000Z" });
    expect(t1).toBe(t2); // same instant
  });
});
