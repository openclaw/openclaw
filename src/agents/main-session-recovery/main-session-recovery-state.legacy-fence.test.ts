import { describe, expect, it } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { legacyFailedRecoveryEntry } from "./main-session-recovery-legacy.test-support.js";
import {
  inspectMainRestartRecoveryRolloverEligibility,
  transitionMainSessionRecovery,
} from "./main-session-recovery-state.js";

const observe = (entry: SessionEntry) =>
  transitionMainSessionRecovery(entry, {
    kind: "observe",
    cycleId: "new-cycle",
    lifecycleGeneration: "new-generation",
    sessionKey: "agent:main:main",
  });

describe("terminal legacy recovery fence adoption", () => {
  it.each([true, false])(
    "retains ambiguous custody for explicit recovery (aborted=%s)",
    (abortedLastRun) => {
      const entry = legacyFailedRecoveryEntry({ abortedLastRun });
      const before = structuredClone(entry);
      expect(observe(entry)).toEqual({ kind: "observed", view: { status: "tombstoned" } });
      expect(entry).toMatchObject({ ...before, abortedLastRun: false });
      expect(entry.mainRestartRecovery).toMatchObject({
        chargedAttempts: 0,
        tombstone: { reason: expect.stringContaining("unmatched recovery fence") },
      });
      expect(inspectMainRestartRecoveryRolloverEligibility(entry)).toEqual({ eligible: true });
      const retained = structuredClone(entry);
      expect(observe(entry)).toEqual({ kind: "observed", view: { status: "tombstoned" } });
      expect(entry).toEqual(retained);
    },
  );

  it.each<Partial<SessionEntry>>([
    { status: "interrupted" },
    { status: undefined },
    { mainRestartRecovery: { cycleId: "owed-cycle", revision: 1, chargedAttempts: 0 } },
    {
      restartRecoveryDeliveryRunId: "owed-delivery",
      restartRecoveryDeliverySourceRunId: "owed-source",
    },
    { pendingFinalDelivery: { kind: "replayable", text: "owed final", createdAt: 100 } },
    {
      restartRecoveryHarnessCompletion: {
        taskId: "owed-task",
        taskRunId: "task-run",
        taskStatus: "succeeded",
        sourceRunId: "task-source",
        requesterSessionKey: "agent:main:main",
        requesterAgentId: "main",
        sessionId: "legacy-session",
      },
    },
    { lifecycleRunId: "unfinished-runtime" },
    { activeWriterRunId: "unfinished-writer" },
  ])("preserves authoritative unfinished custody: %j", (overrides) => {
    const entry = legacyFailedRecoveryEntry(overrides);
    expect(observe(entry)).toMatchObject({ kind: "observed", view: { status: "recoverable" } });
    expect(entry.mainRestartRecovery?.tombstone).toBeUndefined();
  });

  it("does not let foreground adoption turn ambiguous residue into executable custody", () => {
    const entry = legacyFailedRecoveryEntry();
    expect(
      transitionMainSessionRecovery(entry, {
        kind: "claim_foreground",
        cycleId: "new-cycle",
        claimId: "new-claim",
        lifecycleGeneration: "new-generation",
        sessionId: entry.sessionId,
        sessionKey: "agent:main:main",
      }),
    ).toEqual({ kind: "rejected", reason: "already_tombstoned" });
    expect(entry.mainRestartRecovery?.foregroundClaims).toBeUndefined();
    expect(entry.restartRecoveryRuns).toEqual(legacyFailedRecoveryEntry().restartRecoveryRuns);
  });

  it("blocks standalone inspection without mutating ambiguous evidence", () => {
    const entry = legacyFailedRecoveryEntry({ abortedLastRun: false });
    const before = structuredClone(entry);
    expect(
      transitionMainSessionRecovery(entry, {
        kind: "inspect",
        lifecycleGeneration: "new-generation",
        sessionKey: "agent:main:main",
      }),
    ).toEqual({ kind: "observed", view: { status: "blocked" } });
    expect(entry).toEqual(before);
  });

  it("settles matching terminal runtime evidence instead of quarantining it", () => {
    const entry = legacyFailedRecoveryEntry({
      restartRecoveryTerminalRunIds: ["legacy-channel-source", "legacy-runtime"],
    });
    expect(observe(entry)).toEqual({ kind: "observed", view: { status: "inactive" } });
    expect(entry.restartRecoveryRuns).toBeUndefined();
    expect(entry.mainRestartRecovery).toBeUndefined();
  });
});
