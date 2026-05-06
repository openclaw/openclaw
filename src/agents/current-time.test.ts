import { describe, expect, it } from "vitest";
import { appendCronStyleCurrentTimeLine } from "./current-time.js";

const CFG = {
  agents: {
    defaults: {
      userTimezone: "UTC",
    },
  },
};

describe("appendCronStyleCurrentTimeLine", () => {
  it("returns the empty input unchanged", () => {
    expect(appendCronStyleCurrentTimeLine("", CFG, Date.now())).toBe("");
  });

  it("appends a Current time line when none is present", () => {
    const out = appendCronStyleCurrentTimeLine(
      "Heartbeat tick",
      CFG,
      Date.parse("2026-04-30T10:00:00Z"),
    );
    expect(out).toContain("Heartbeat tick");
    expect(out).toMatch(/Current time:.*2026-04-30 10:00 UTC/);
  });

  it("refreshes an existing Current time line on subsequent calls (#44993)", () => {
    const oldNow = Date.parse("2026-04-30T08:00:00Z");
    const newNow = Date.parse("2026-04-30T10:00:00Z");
    const firstPass = appendCronStyleCurrentTimeLine("Heartbeat tick", CFG, oldNow);
    expect(firstPass).toMatch(/Current time:.*2026-04-30 08:00 UTC/);

    const secondPass = appendCronStyleCurrentTimeLine(firstPass, CFG, newNow);
    // Regression: previously this returned firstPass unchanged because of the
    // `base.includes("Current time:")` early-return guard, leaking a stale
    // 08:00 UTC timestamp into every subsequent heartbeat. After the fix the
    // existing line must be replaced with the fresh nowMs.
    expect(secondPass).toContain("Heartbeat tick");
    expect(secondPass).toMatch(/Current time:.*2026-04-30 10:00 UTC/);
    expect(secondPass).not.toMatch(/2026-04-30 08:00 UTC/);
    expect(secondPass.match(/Current time:/g)?.length).toBe(1);
  });

  it("collapses multiple Current time lines into a single fresh entry", () => {
    // Stale lines simulate the helper's natural-language `formatUserTime` shape:
    // `Current time: <natural> (<TZ>) / YYYY-MM-DD HH:MM UTC`.
    const stale = [
      "Heartbeat tick",
      "Current time: Wednesday, January 1st, 2025 - 12:00 AM (UTC) / 2025-01-01 00:00 UTC",
      "Current time: Thursday, January 2nd, 2025 - 12:00 AM (UTC) / 2025-01-02 00:00 UTC",
    ].join("\n");
    const newNow = Date.parse("2026-04-30T10:00:00Z");
    const out = appendCronStyleCurrentTimeLine(stale, CFG, newNow);
    expect(out).toContain("Heartbeat tick");
    expect(out).toMatch(/Current time:.*2026-04-30 10:00 UTC/);
    expect(out).not.toMatch(/2025-01-01 00:00 UTC/);
    expect(out).not.toMatch(/2025-01-02 00:00 UTC/);
    expect(out.match(/Current time:/g)?.length).toBe(1);
  });

  it("matches helper lines with natural-language formattedTime (#44993 codex P1)", () => {
    // Regression: the helper's `formatUserTime` returns natural-language strings
    // (e.g. `Thursday, April 30th, 2026 - 10:00 AM`), so a regex anchored on
    // `^Current time: \d{4}-\d{2}-\d{2}` would NEVER match the helper-emitted
    // line and the refresh path would silently fall into append mode, leaking
    // stale `Current time:` lines forever. This test pins the natural-language
    // shape so a future tightening cannot reintroduce the same regression.
    const helperShape =
      "Heartbeat tick\nCurrent time: Thursday, April 30th, 2026 - 10:00 AM (Asia/Seoul) / 2026-04-30 01:00 UTC";
    const newNow = Date.parse("2026-04-30T10:00:00Z");
    const out = appendCronStyleCurrentTimeLine(helperShape, CFG, newNow);
    // The natural-language helper line MUST be replaced (not appended-after).
    expect(out).not.toMatch(/Asia\/Seoul/);
    expect(out.match(/Current time:/g)?.length).toBe(1);
    expect(out).toMatch(/Current time:.*2026-04-30 10:00 UTC/);
  });

  it("preserves user-authored content that starts with 'Current time:' (Codex P2)", () => {
    // Reminder/cron text passed through `heartbeat-events-filter.ts` may
    // legitimately start with "Current time:" but does NOT match the helper's
    // exact injected shape (deterministic `(<TZ>) / YYYY-MM-DD HH:MM UTC` tail).
    // The helper must leave such lines alone and append a fresh injected line.
    const userContent =
      "Reminder from cron:\nCurrent time: please check the dashboard before EOD";
    const newNow = Date.parse("2026-04-30T10:00:00Z");
    const out = appendCronStyleCurrentTimeLine(userContent, CFG, newNow);
    expect(out).toContain("Reminder from cron:");
    // User-authored "Current time:" line MUST survive untouched.
    expect(out).toContain("Current time: please check the dashboard before EOD");
    // The helper's own injected line is appended (since no helper-format line existed).
    expect(out).toMatch(/Current time: .+? \(UTC\) \/ 2026-04-30 10:00 UTC/);
    // Two `Current time:` occurrences expected: 1 user-authored + 1 helper-injected.
    expect(out.match(/Current time:/g)?.length).toBe(2);
  });
});
