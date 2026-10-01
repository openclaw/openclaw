import { describe, expect, it } from "vitest";
import { formatSummarizationHistoryText } from "./utils.js";

// 2026-07-01 12:00:00 UTC. The same instant in any zone, so assertions can
// compare timezone-aware output deterministically.
const SAMPLE_TS = Date.UTC(2026, 6, 1, 12, 0, 0);

describe("formatSummarizationHistoryText", () => {
  it("shifts the local time relative to the UTC baseline when a non-UTC zone is configured", () => {
    const history = [{ author: "~a", content: "x", timestamp: SAMPLE_TS }];
    const utc = formatSummarizationHistoryText(history, {
      agents: { defaults: { userTimezone: "UTC" } },
    });
    const shanghai = formatSummarizationHistoryText(history, {
      agents: { defaults: { userTimezone: "Asia/Shanghai" } },
    });
    const newYork = formatSummarizationHistoryText(history, {
      agents: { defaults: { userTimezone: "America/New_York" } },
    });
    expect(utc).toContain("2026-07-01T12:00:00Z");
    expect(utc).toContain("~a");
    expect(utc).toContain("x");
    expect(shanghai).toContain("20:00:00");
    expect(newYork).toContain("08:00:00");
    expect(shanghai).not.toBe(utc);
    expect(newYork).not.toBe(utc);
  });

  it("joins multiple entries with newlines", () => {
    const history = [
      { author: "~a", content: "first", timestamp: SAMPLE_TS },
      { author: "~b", content: "second", timestamp: SAMPLE_TS + 60_000 },
    ];
    const text = formatSummarizationHistoryText(history, {
      agents: { defaults: { userTimezone: "UTC" } },
    });
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain("first");
    expect(text).toContain("second");
  });
});
