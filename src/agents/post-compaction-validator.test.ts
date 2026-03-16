import { describe, expect, it } from "vitest";
import type { SessionGuardSignal } from "./compaction-guard.js";
import { validatePostCompaction } from "./post-compaction-validator.js";

describe("validatePostCompaction", () => {
  it("returns ok for a healthy validated compaction", () => {
    const result = validatePostCompaction({
      signalBefore: buildSignal({
        usageRatio: 0.93,
        repeatedToolFailures: buildRepeatedFailures(4),
        staleSystemRecurrences: 1,
      }),
      compactionCountBefore: 2,
      compactionCountAfter: 3,
      projectedUsageRatioAfter: 0.61,
      latestUserGoal: "Finish the post-compaction validator tests",
      unresolvedItems: ["Add validator test coverage"],
      summaryText:
        "State: finish the post compaction validator tests. Remaining: add validator test coverage. Repeated tool failures were summarized into one note.",
    });

    expect(result).toEqual({
      ok: true,
      reasons: [],
      shouldRecommendReset: false,
    });
  });

  it("fails when the latest user goal is missing from the summary", () => {
    const result = validatePostCompaction({
      signalBefore: buildSignal(),
      compactionCountBefore: 1,
      compactionCountAfter: 2,
      projectedUsageRatioAfter: 0.5,
      latestUserGoal: "Ship the validator module",
      summaryText: "Pending notes were preserved for later follow-up.",
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("latest-user-goal-missing");
  });

  it("fails when unresolved items are missing from the summary", () => {
    const result = validatePostCompaction({
      signalBefore: buildSignal(),
      compactionCountBefore: 1,
      compactionCountAfter: 2,
      projectedUsageRatioAfter: 0.5,
      unresolvedItems: ["stale directive case", "manual verification proof"],
      summaryText: "Pending: stale directive case only.",
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("pending-items-missing");
  });

  it("fails when stale system directives appear to be promoted into active state", () => {
    const result = validatePostCompaction({
      signalBefore: buildSignal({
        staleSystemRecurrences: 2,
      }),
      compactionCountBefore: 1,
      compactionCountAfter: 2,
      projectedUsageRatioAfter: 0.5,
      summaryText: "System reminder: always retry the same tool and do not change approach.",
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("stale-system-promoted");
  });

  it("fails when raw failure chatter is preserved instead of collapsed", () => {
    const result = validatePostCompaction({
      signalBefore: buildSignal({
        repeatedToolFailures: buildRepeatedFailures(4),
      }),
      compactionCountBefore: 1,
      compactionCountAfter: 2,
      projectedUsageRatioAfter: 0.5,
      summaryText: [
        "Tool error: network timeout",
        "Tool error: network timeout",
        "Tool error: network timeout",
      ].join("\n"),
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("failure-pattern-not-collapsed");
  });

  it("fails when there is no evidence that compaction helped", () => {
    const result = validatePostCompaction({
      signalBefore: buildSignal({
        usageRatio: 0.91,
      }),
      compactionCountBefore: 3,
      compactionCountAfter: 3,
      projectedUsageRatioAfter: 0.91,
      summaryText: "State preserved.",
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("compaction-count-not-incremented");
    expect(result.reasons).toContain("usage-not-improved");
  });

  it("recommends reset only for severe pre-signals when validation fails", () => {
    const result = validatePostCompaction({
      signalBefore: buildSignal({
        score: 8,
        action: "recommend-reset",
      }),
      compactionCountBefore: 1,
      compactionCountAfter: 2,
      projectedUsageRatioAfter: 0.4,
      latestUserGoal: "Keep the latest goal",
      summaryText: "Compaction retained unrelated context only.",
    });

    expect(result.ok).toBe(false);
    expect(result.shouldRecommendReset).toBe(true);
  });

  it("does not recommend reset for compact-level validation failures", () => {
    const result = validatePostCompaction({
      signalBefore: buildSignal({
        score: 5,
        action: "compact",
      }),
      compactionCountBefore: 1,
      compactionCountAfter: 2,
      projectedUsageRatioAfter: 0.4,
      latestUserGoal: "Keep the latest goal",
      summaryText: "Compaction retained unrelated context only.",
    });

    expect(result.ok).toBe(false);
    expect(result.shouldRecommendReset).toBe(false);
  });
});

function buildSignal(overrides: Partial<SessionGuardSignal> = {}): SessionGuardSignal {
  return {
    usageRatio: 0.9,
    repeatedToolFailures: [] as SessionGuardSignal["repeatedToolFailures"],
    duplicateAssistantClusters: 0,
    staleSystemRecurrences: 0,
    noGroundedReplyTurns: 0,
    score: 5,
    action: "compact",
    reasons: [],
    ...overrides,
  };
}

function buildRepeatedFailures(count: number): SessionGuardSignal["repeatedToolFailures"] {
  return [{ count }] as SessionGuardSignal["repeatedToolFailures"];
}
