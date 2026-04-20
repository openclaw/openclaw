import { describe, expect, it } from "vitest";
import type { LogEntry } from "./logger.js";
import { filterWindow, lastNDaysWindow, parseEntries, summarize, type Window } from "./stats.js";

function entry(overrides: Partial<LogEntry>): LogEntry {
  return {
    timestamp: "2026-04-14T00:00:00.000Z",
    promptLength: 50,
    sensitivity: "internal",
    tier: "simple",
    confidence: 0.9,
    alias: "speed",
    modelRef: "anthropic/claude-haiku-4-5",
    escalated: false,
    rejected: false,
    ...overrides,
  };
}

describe("aj-router stats", () => {
  it("summarizes counts per alias and escalation rate", () => {
    const window: Window = {
      startMs: Date.parse("2026-04-10T00:00:00.000Z"),
      endMs: Date.parse("2026-04-17T00:00:00.000Z"),
    };
    const rows: LogEntry[] = [
      entry({ alias: "speed" }),
      entry({ alias: "speed" }),
      entry({ alias: "workhorse", tier: "medium", confidence: 0.85 }),
      entry({
        alias: "workhorse",
        tier: "medium",
        confidence: 0.7,
        escalated: true,
      }),
      entry({ rejected: true, alias: undefined, modelRef: undefined }),
    ];
    const summary = summarize(rows, window);
    expect(summary.totalDecisions).toBe(5);
    expect(summary.rejected).toBe(1);
    expect(summary.escalated).toBe(1);
    expect(summary.perAlias).toEqual([
      { alias: "speed", count: 2 },
      { alias: "workhorse", count: 2 },
    ]);
    expect(summary.averageConfidence).toBeCloseTo((0.9 + 0.9 + 0.85 + 0.7) / 4);
  });

  it("filters entries outside the window", () => {
    const inside = entry({ timestamp: "2026-04-14T12:00:00.000Z" });
    const before = entry({ timestamp: "2026-03-01T00:00:00.000Z" });
    const after = entry({ timestamp: "2027-01-01T00:00:00.000Z" });
    const filtered = filterWindow([inside, before, after], {
      startMs: Date.parse("2026-04-10T00:00:00.000Z"),
      endMs: Date.parse("2026-04-17T00:00:00.000Z"),
    });
    expect(filtered).toEqual([inside]);
  });

  it("parseEntries skips blank and malformed lines", () => {
    const text = [
      JSON.stringify(entry({})),
      "",
      "{ not json",
      JSON.stringify(entry({ alias: "flagship" })),
    ].join("\n");
    const rows = parseEntries(text);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.alias).toBe("flagship");
  });

  it("lastNDaysWindow returns a window with correct span", () => {
    const now = new Date("2026-04-17T12:00:00.000Z");
    const window = lastNDaysWindow(7, now);
    expect(window.endMs).toBe(now.getTime());
    expect(window.endMs - window.startMs).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
