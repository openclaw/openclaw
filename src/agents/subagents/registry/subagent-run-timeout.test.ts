// Subagent run timeout tests keep semantic deadlines separate from the maximum
// delay that Node timers can safely schedule.
import { describe, expect, it } from "vitest";
import {
  resolveSubagentRunDeadlineMs,
  resolveSubagentRunDurationMs,
  resolveSubagentRunEffectiveEndedAt,
} from "./subagent-run-timeout.js";

describe("subagent run timeout helpers", () => {
  it("preserves semantic deadlines longer than the timer cap", () => {
    const thirtyDaysSeconds = 30 * 24 * 60 * 60;

    expect(resolveSubagentRunDurationMs(thirtyDaysSeconds)).toBe(2_592_000_000);
    expect(
      resolveSubagentRunDeadlineMs({
        createdAt: 1_000,
        runTimeoutSeconds: thirtyDaysSeconds,
        execution: {},
      }),
    ).toBe(2_592_001_000);
  });

  it("waits for the collector lifecycle start before setting its deadline", () => {
    expect(
      resolveSubagentRunDeadlineMs({
        collect: true,
        createdAt: 1_000,
        runTimeoutSeconds: 60,
        execution: {},
      }),
    ).toBeUndefined();
    expect(
      resolveSubagentRunDeadlineMs(
        {
          collect: true,
          createdAt: 1_000,
          runTimeoutSeconds: 60,
          execution: {},
        },
        5_000,
      ),
    ).toBe(65_000);
  });

  it("clamps delayed terminal observations to the explicit deadline", () => {
    expect(
      resolveSubagentRunEffectiveEndedAt(
        { createdAt: 1_000, execution: { startedAt: 2_000 }, runTimeoutSeconds: 3 },
        6_000,
      ),
    ).toBe(5_000);
  });

  it("ignores invalid timeout seconds and invalid start timestamps", () => {
    expect(resolveSubagentRunDurationMs(Number.NaN)).toBeUndefined();
    expect(resolveSubagentRunDurationMs(0)).toBeUndefined();
    expect(
      resolveSubagentRunDeadlineMs({
        createdAt: Number.POSITIVE_INFINITY,
        runTimeoutSeconds: 60,
        execution: {},
      }),
    ).toBeUndefined();
  });
});
