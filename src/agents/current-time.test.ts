import { describe, expect, it } from "vitest";
import { appendCronStyleCurrentTimeLine } from "./current-time.js";

const cfg = {};
const nowMs = new Date("2026-01-15T10:00:00Z").getTime();

describe("appendCronStyleCurrentTimeLine", () => {
  it("appends a Current time line when none is present", () => {
    const result = appendCronStyleCurrentTimeLine("Check system health.", cfg, nowMs);
    expect(result).toContain("Check system health.");
    expect(result).toMatch(/Current time:/);
  });

  it("replaces a stale Current time line on repeated runs", () => {
    const first = appendCronStyleCurrentTimeLine("Run diagnostics.", cfg, nowMs);
    const laterMs = new Date("2026-01-15T11:00:00Z").getTime();
    const second = appendCronStyleCurrentTimeLine(first, cfg, laterMs);
    // Should contain the updated time, not the original
    const lines = second.split("\n").filter((l) => l.startsWith("Current time:"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toEqual(first.split("\n").find((l) => l.startsWith("Current time:")));
  });

  it("returns empty string unchanged", () => {
    expect(appendCronStyleCurrentTimeLine("", cfg, nowMs)).toBe("");
  });

  it("returns whitespace-only string as empty", () => {
    expect(appendCronStyleCurrentTimeLine("   ", cfg, nowMs)).toBe("");
  });

  it("does not replace user-authored Current time lines", () => {
    const base = "Current time: check the clock on the wall";
    const result = appendCronStyleCurrentTimeLine(base, cfg, nowMs);
    // User line preserved, runtime timestamp appended separately
    expect(result).toContain("Current time: check the clock on the wall");
    expect(result.split("\n").filter((l) => l.startsWith("Current time:")).length).toBe(2);
  });
});
