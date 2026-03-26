import { describe, expect, it } from "vitest";
import { resolveDefaultGuardThresholds, scoreCompactionGuard } from "./compaction-guard.js";
import type { TranscriptTailSignal } from "./transcript-tail-detector.js";

describe("resolveDefaultGuardThresholds", () => {
  it("returns the documented defaults", () => {
    expect(resolveDefaultGuardThresholds()).toEqual({
      warnUsageRatio: 0.85,
      riskUsageRatio: 0.9,
      forceUsageRatio: 0.95,
      repeatedToolFailureThreshold: 3,
      duplicateAssistantThreshold: 2,
      staleSystemRecurrenceThreshold: 2,
      noGroundedReplyTurnsThreshold: 4,
    });
  });
});

describe("scoreCompactionGuard", () => {
  it("returns none for a low-risk session", () => {
    expect(
      scoreCompactionGuard({
        usageRatio: 0.84,
        transcript: createTranscriptSignal(),
      }),
    ).toEqual({
      usageRatio: 0.84,
      repeatedToolFailures: [],
      duplicateAssistantClusters: 0,
      staleSystemRecurrences: 0,
      noGroundedReplyTurns: 0,
      score: 0,
      action: "none",
      reasons: [],
    });
  });

  it("returns warn when usage pressure and duplicate assistant clusters cross thresholds", () => {
    const signal = scoreCompactionGuard({
      usageRatio: 0.9,
      transcript: createTranscriptSignal({
        duplicateAssistantClusters: 2,
      }),
    });

    expect(signal.score).toBe(4);
    expect(signal.action).toBe("warn");
    expect(signal.reasons).toEqual([
      "usage>=warn",
      "usage>=risk",
      "duplicateAssistantClusters>=threshold",
    ]);
  });

  it("returns compact when combined loop signals reach the compaction band", () => {
    const signal = scoreCompactionGuard({
      usageRatio: 0.85,
      transcript: createTranscriptSignal({
        repeatedToolFailures: [createRepeatedToolFailure("shell: timeout", 3)],
        noGroundedReplyTurns: 4,
      }),
    });

    expect(signal.score).toBe(5);
    expect(signal.action).toBe("compact");
    expect(signal.reasons).toEqual([
      "usage>=warn",
      "repeatedToolFailures>=threshold",
      "noGroundedReplyTurns>=threshold",
    ]);
  });

  it("returns reset-candidate for high score under force-level usage", () => {
    const signal = scoreCompactionGuard({
      usageRatio: 0.96,
      transcript: createTranscriptSignal({
        repeatedToolFailures: [createRepeatedToolFailure("shell: timeout", 3)],
        staleSystemRecurrences: 2,
        noGroundedReplyTurns: 4,
      }),
    });

    expect(signal.score).toBe(11);
    expect(signal.action).toBe("reset-candidate");
    expect(signal.reasons).toEqual([
      "usage>=warn",
      "usage>=risk",
      "usage>=force",
      "repeatedToolFailures>=threshold",
      "staleSystemRecurrences>=threshold",
      "noGroundedReplyTurns>=threshold",
    ]);
  });

  it("stays below and above the risk threshold deterministically", () => {
    const justBelowRisk = scoreCompactionGuard({
      usageRatio: 0.899,
      transcript: createTranscriptSignal({
        duplicateAssistantClusters: 2,
      }),
    });
    const atRisk = scoreCompactionGuard({
      usageRatio: 0.9,
      transcript: createTranscriptSignal({
        duplicateAssistantClusters: 2,
      }),
    });

    expect(justBelowRisk.score).toBe(2);
    expect(justBelowRisk.action).toBe("none");
    expect(justBelowRisk.reasons).toEqual(["usage>=warn", "duplicateAssistantClusters>=threshold"]);

    expect(atRisk.score).toBe(4);
    expect(atRisk.action).toBe("warn");
    expect(atRisk.reasons).toEqual([
      "usage>=warn",
      "usage>=risk",
      "duplicateAssistantClusters>=threshold",
    ]);
  });

  it("counts repeated tool failures at most once even when multiple groups cross the threshold", () => {
    const signal = scoreCompactionGuard({
      usageRatio: 0.85,
      transcript: createTranscriptSignal({
        repeatedToolFailures: [
          createRepeatedToolFailure("shell: timeout", 3),
          createRepeatedToolFailure("fetch: 500", 5),
        ],
      }),
    });

    expect(signal.score).toBe(3);
    expect(signal.action).toBe("warn");
    expect(signal.reasons).toEqual(["usage>=warn", "repeatedToolFailures>=threshold"]);
  });

  it("applies custom thresholds on top of the defaults", () => {
    const signal = scoreCompactionGuard({
      usageRatio: 0.8,
      transcript: createTranscriptSignal({
        duplicateAssistantClusters: 1,
      }),
      thresholds: {
        warnUsageRatio: 0.8,
        riskUsageRatio: 0.8,
        duplicateAssistantThreshold: 1,
      },
    });

    expect(signal.score).toBe(4);
    expect(signal.action).toBe("warn");
    expect(signal.reasons).toEqual([
      "usage>=warn",
      "usage>=risk",
      "duplicateAssistantClusters>=threshold",
    ]);
  });
});

function createTranscriptSignal(
  overrides: Partial<TranscriptTailSignal> = {},
): TranscriptTailSignal {
  return {
    repeatedToolFailures: [],
    duplicateAssistantClusters: 0,
    staleSystemRecurrences: 0,
    noGroundedReplyTurns: 0,
    ...overrides,
  };
}

function createRepeatedToolFailure(
  signature: string,
  count: number,
): TranscriptTailSignal["repeatedToolFailures"][number] {
  return {
    signature,
    count,
    lastSeenEntryId: `${signature}-${count}`,
  };
}
