import { describe, expect, it } from "vitest";
import { appendCronStyleCurrentTimeLine, resolveCronStyleNow } from "./current-time.js";

const cfg = { agents: { defaults: { userTimezone: "UTC" } } };
const nowMs = new Date("2026-03-13T12:00:00Z").getTime();

describe("appendCronStyleCurrentTimeLine", () => {
  it("appends a Current time line when none exists", () => {
    const result = appendCronStyleCurrentTimeLine("Hello world", cfg, nowMs);
    expect(result).toContain("Hello world");
    expect(result).toContain("Current time:");
    expect(result).toContain("2026-03-13");
  });

  it("returns empty string unchanged", () => {
    expect(appendCronStyleCurrentTimeLine("", cfg, nowMs)).toBe("");
    expect(appendCronStyleCurrentTimeLine("   ", cfg, nowMs)).toBe("");
  });

  it("refreshes a stale Current time line with a fresh timestamp", () => {
    const staleMs = new Date("2026-03-12T08:00:00Z").getTime();
    const staleText = appendCronStyleCurrentTimeLine("Check status", cfg, staleMs);
    expect(staleText).toContain("2026-03-12");

    // Now refresh with a new timestamp — must replace, not skip
    const freshMs = new Date("2026-03-13T14:30:00Z").getTime();
    const refreshed = appendCronStyleCurrentTimeLine(staleText, cfg, freshMs);
    expect(refreshed).toContain("2026-03-13");
    expect(refreshed).not.toContain("2026-03-12");
    // Should have exactly one "Current time:" line
    const matches = refreshed.match(/Current time:/g);
    expect(matches).toHaveLength(1);
  });

  it("preserves surrounding text when refreshing timestamp", () => {
    const text =
      "Line one\nCurrent time: 2026-01-01 00:00 (UTC) / 2026-01-01 00:00 UTC\nLine three";
    const result = appendCronStyleCurrentTimeLine(text, cfg, nowMs);
    expect(result).toContain("Line one");
    expect(result).toContain("Line three");
    expect(result).toContain("2026-03-13");
    expect(result).not.toContain("2026-01-01");
  });

  it("does not duplicate Current time line on repeated calls", () => {
    let text = "Heartbeat prompt";
    for (let i = 0; i < 5; i++) {
      const ms = nowMs + i * 60_000;
      text = appendCronStyleCurrentTimeLine(text, cfg, ms);
    }
    const matches = text.match(/Current time:/g);
    expect(matches).toHaveLength(1);
    expect(text).toContain("Heartbeat prompt");
  });

  it("refreshes when Current time is the only line", () => {
    const staleMs = new Date("2026-01-01T00:00:00Z").getTime();
    const { timeLine: staleLine } = resolveCronStyleNow(cfg, staleMs);
    const refreshed = appendCronStyleCurrentTimeLine(staleLine, cfg, nowMs);
    expect(refreshed).toContain("2026-03-13");
    expect(refreshed).not.toContain("2026-01-01");
  });

  it("refreshed line matches resolveCronStyleNow output format", () => {
    const staleText = appendCronStyleCurrentTimeLine("Prompt", cfg, nowMs);
    const freshMs = new Date("2026-06-15T09:30:00Z").getTime();
    const refreshed = appendCronStyleCurrentTimeLine(staleText, cfg, freshMs);
    const { timeLine: expected } = resolveCronStyleNow(cfg, freshMs);
    expect(refreshed).toContain(expected);
  });

  it("does not replace Current time embedded mid-line", () => {
    const text = "Check the Current time: section for details";
    const result = appendCronStyleCurrentTimeLine(text, cfg, nowMs);
    // "Current time:" not at line start — should append, not replace
    expect(result).toContain("Check the Current time: section for details");
    const matches = result.match(/Current time:/g);
    expect(matches).toHaveLength(2);
  });
});

describe("resolveCronStyleNow", () => {
  it("returns formatted time with timezone and UTC", () => {
    const result = resolveCronStyleNow(cfg, nowMs);
    expect(result.timeLine).toContain("Current time:");
    expect(result.timeLine).toContain("UTC");
    expect(result.userTimezone).toBeDefined();
    expect(result.formattedTime).toBeDefined();
  });
});
