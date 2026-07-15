import { describe, expect, it } from "vitest";
import { resolveAttendanceGraceMinutes } from "./attendance-grace.js";

describe("resolveAttendanceGraceMinutes", () => {
  it("defaults missing or non-finite values", () => {
    expect(resolveAttendanceGraceMinutes(undefined)).toBe(5);
    expect(resolveAttendanceGraceMinutes(Number.NaN)).toBe(5);
    expect(resolveAttendanceGraceMinutes(1.9)).toBe(1);
  });

  it("preserves finite windows above one day", () => {
    expect(resolveAttendanceGraceMinutes(1_441)).toBe(1_441);
    expect(resolveAttendanceGraceMinutes(100_000)).toBe(100_000);
  });

  it("falls back for overflow-class values that would become Infinity grace", () => {
    expect(resolveAttendanceGraceMinutes(Number.MAX_SAFE_INTEGER)).toBe(5);
    expect(resolveAttendanceGraceMinutes(1e308)).toBe(5);
    expect(Number.isFinite(resolveAttendanceGraceMinutes(1e308) * 60_000)).toBe(true);
  });
});
