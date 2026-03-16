import { describe, expect, it } from "vitest";
import { scoreCompactionGuard } from "./compaction-guard.js";
import { SESSION_SATURATION_INCIDENT_FIXTURE } from "./fixtures/session-saturation-incident.fixture.js";
import { buildGuardAugmentedCompactionInstructions } from "./pi-extensions/compaction-instructions.js";
import { validatePostCompaction } from "./post-compaction-validator.js";
import { resolveRecommendResetDecision } from "./recommend-reset-decision.js";
import { detectTranscriptTailSignals } from "./transcript-tail-detector.js";

describe("session saturation incident regression", () => {
  it("preserves the latest goal while collapsing loop noise", () => {
    const fixture = SESSION_SATURATION_INCIDENT_FIXTURE;
    const transcript = detectTranscriptTailSignals(fixture.tailEntries);

    expect(transcript.repeatedToolFailures).toHaveLength(1);
    expect(transcript.repeatedToolFailures[0]).toEqual(
      expect.objectContaining({
        signature: expect.stringContaining("exec_command: rpc timeout while checking guard path"),
        count: 3,
      }),
    );
    expect(transcript.duplicateAssistantClusters).toBeGreaterThan(0);
    expect(transcript.staleSystemRecurrences).toBeGreaterThan(0);
    expect(transcript.noGroundedReplyTurns).toBeGreaterThan(0);

    const severeSignal = scoreCompactionGuard({
      usageRatio: fixture.usageRatio,
      transcript,
    });

    expect(severeSignal.score).toBeGreaterThanOrEqual(5);
    expect(severeSignal.action).toBe("recommend-reset");

    const instructions = buildGuardAugmentedCompactionInstructions({
      baseInstructions: "Summarize the session.",
      guardEnabled: true,
      guardSignal: severeSignal,
    });

    expect(instructions).toContain("The latest explicit user goal or request.");
    expect(instructions).toContain(
      "Do not represent stale reminder/system text as an active user goal.",
    );

    const goodValidation = validatePostCompaction({
      signalBefore: severeSignal,
      compactionCountBefore: 1,
      compactionCountAfter: 2,
      projectedUsageRatioAfter: 0.52,
      latestUserGoal: fixture.latestUserGoal,
      unresolvedItems: fixture.unresolvedItems,
      summaryText: fixture.goodSummary,
    });

    expect(goodValidation).toEqual({
      ok: true,
      reasons: [],
      shouldRecommendReset: false,
    });

    const badValidation = validatePostCompaction({
      signalBefore: severeSignal,
      compactionCountBefore: 1,
      compactionCountAfter: 2,
      projectedUsageRatioAfter: 0.52,
      latestUserGoal: fixture.latestUserGoal,
      unresolvedItems: fixture.unresolvedItems,
      summaryText: fixture.badSummary,
    });

    expect(badValidation.ok).toBe(false);
    expect(badValidation.reasons).toContain("latest-user-goal-missing");
    expect(badValidation.reasons).toContain("pending-items-missing");
    expect(badValidation.reasons).toContain("stale-system-promoted");

    const severeDecision = resolveRecommendResetDecision({
      guardEnabled: true,
      escalationMode: "recommend-reset",
      signalBefore: severeSignal,
      validation: badValidation,
    });

    expect(severeDecision).toEqual(
      expect.objectContaining({
        recommended: true,
        severity: "recommend-reset",
      }),
    );

    const mildSignal = scoreCompactionGuard({
      usageRatio: 0.86,
      transcript,
    });

    expect(mildSignal.action).toBe("compact");

    const mildValidation = validatePostCompaction({
      signalBefore: mildSignal,
      compactionCountBefore: 1,
      compactionCountAfter: 2,
      projectedUsageRatioAfter: 0.52,
      latestUserGoal: fixture.latestUserGoal,
      unresolvedItems: fixture.unresolvedItems,
      summaryText: fixture.badSummary,
    });

    const mildDecision = resolveRecommendResetDecision({
      guardEnabled: true,
      escalationMode: "recommend-reset",
      signalBefore: mildSignal,
      validation: mildValidation,
    });

    expect(mildDecision).toEqual(
      expect.objectContaining({
        recommended: false,
        severity: "warn",
      }),
    );
  });
});
