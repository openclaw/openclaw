import { describe, expect, it } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { projectMainSessionRecoveryLifecycle } from "./main-session-recovery-lifecycle.js";
import { transitionMainSessionRecovery } from "./main-session-recovery-state.js";

type Projection = Parameters<typeof projectMainSessionRecoveryLifecycle>[0];
const current = "generation-current";
function project(
  entry: Projection["entry"],
  lifecycleGeneration = current,
  data: Projection["event"]["data"] = { phase: "end" },
  snapshotPatch: Projection["snapshotPatch"] = { status: "done", abortedLastRun: false },
  runId = "recovery",
) {
  return projectMainSessionRecoveryLifecycle({
    currentLifecycleGeneration: current,
    entry,
    event: { runId, lifecycleGeneration, data },
    snapshotPatch,
  });
}

function recoveryEntry(params?: {
  hasCurrentOwner?: boolean;
  ownsDelivery?: boolean;
}): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 100,
    abortedLastRun: false,
    ...(params?.ownsDelivery ? { restartRecoveryDeliveryRunId: "recovery" } : {}),
    restartRecoveryRuns: [
      { runId: "recovery", lifecycleGeneration: "generation-old" },
      { runId: "recovery", lifecycleGeneration: "generation-current" },
    ],
    mainRestartRecovery: {
      cycleId: "cycle-1",
      revision: 5,
      chargedAttempts: 2,
      ...(params?.hasCurrentOwner
        ? {
            foregroundClaims: {
              lifecycleGeneration: "generation-current",
              tokens: ["current-owner"],
            },
          }
        : {}),
    },
  };
}

describe("main-session recovery run ownership", () => {
  it.each([
    { lifecycleGeneration: "generation-current", abortedLastRun: false, action: "apply" },
    { lifecycleGeneration: "generation-current", abortedLastRun: true, action: "suppress" },
    { lifecycleGeneration: "generation-old", abortedLastRun: false, action: "suppress" },
  ] as const)(
    "fences a prearmed start ($lifecycleGeneration, interrupted=$abortedLastRun)",
    ({ lifecycleGeneration, abortedLastRun, action }) => {
      const patch = { status: undefined, abortedLastRun: false, startedAt: 200 };
      expect(
        project(
          {
            abortedLastRun,
            restartRecoveryRuns: [{ runId: "admitted", lifecycleGeneration }],
          },
          lifecycleGeneration,
          { phase: "start" },
          patch,
          "admitted",
        ),
      ).toEqual(action === "apply" ? { action, patch } : { action });
    },
  );

  it("transfers process-owned recovery leases to a restart marker", () => {
    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 100,
      status: "interrupted",
      abortedLastRun: true,
      restartRecoveryRuns: [{ runId: "drain-run", lifecycleGeneration: "generation-current" }],
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 4,
        chargedAttempts: 2,
        reservation: {
          runId: "reserved-run",
          attempt: 2,
          lifecycleGeneration: "generation-current",
        },
        foregroundClaims: {
          lifecycleGeneration: "generation-current",
          tokens: ["foreground-1"],
          runIdsByClaimId: { "foreground-1": "drain-run" },
        },
      },
    };

    transitionMainSessionRecovery(entry, {
      kind: "mark_interrupted",
      cycleId: "unused-cycle",
      now: 200,
      runs: [{ runId: "drain-run", lifecycleGeneration: "generation-current" }],
    });

    expect(entry.mainRestartRecovery).toEqual({
      cycleId: "cycle-1",
      revision: 5,
      chargedAttempts: 2,
    });
    expect(project(entry, current, { phase: "end" }, undefined, "drain-run")).toEqual({
      action: "apply",
      patch: { restartRecoveryRuns: undefined },
    });
  });

  it("settles a resumed run once when older generations retain the same run id", () => {
    expect(project(recoveryEntry())).toEqual({
      action: "apply",
      patch: {
        status: "done",
        abortedLastRun: false,
        restartRecoveryRuns: undefined,
        mainRestartRecovery: undefined,
      },
    });
  });

  it.each([
    { name: "admitted delivery owner", params: { ownsDelivery: true } },
    { name: "foreground owner", params: { hasCurrentOwner: true, ownsDelivery: true } },
  ])("does not let an older same-id terminal settle or tombstone its $name", ({ params }) => {
    expect(project(recoveryEntry(params), "generation-old")).toEqual({
      action: "apply",
      patch: {
        restartRecoveryRuns: [{ runId: "recovery", lifecycleGeneration: "generation-current" }],
      },
    });
  });

  it("suppresses a duplicate older terminal after its fence has been consumed", () => {
    const entry = recoveryEntry({ ownsDelivery: true });
    entry.restartRecoveryRuns = [{ runId: "recovery", lifecycleGeneration: "generation-current" }];

    expect(project(entry, "generation-old")).toEqual({ action: "suppress" });
  });
});
