import { describe, expect, it } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { projectMainSessionRecoveryLifecycle } from "./main-session-recovery-lifecycle.js";
import { transitionMainSessionRecovery } from "./main-session-recovery-state.js";
import {
  recoveryEntry as makeEntry,
  recoveryState,
} from "./main-session-recovery-state.test-support.js";

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
  return makeEntry({
    ...(params?.ownsDelivery ? { restartRecoveryDeliveryRunId: "recovery" } : {}),
    restartRecoveryRuns: [
      { runId: "recovery", lifecycleGeneration: "generation-old" },
      { runId: "recovery", lifecycleGeneration: "generation-current" },
    ],
    mainRestartRecovery: recoveryState({
      revision: 5,
      chargedAttempts: 2,
      foregroundClaims: params?.hasCurrentOwner
        ? { lifecycleGeneration: current, tokens: ["current-owner"] }
        : undefined,
    }),
  });
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
    const session = makeEntry({
      status: "interrupted",
      abortedLastRun: true,
      restartRecoveryRuns: [{ runId: "drain-run", lifecycleGeneration: "generation-current" }],
      mainRestartRecovery: recoveryState({
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
      }),
    });

    transitionMainSessionRecovery(session, {
      kind: "mark_interrupted",
      cycleId: "unused-cycle",
      now: 200,
      runs: [{ runId: "drain-run", lifecycleGeneration: "generation-current" }],
    });

    expect(session.mainRestartRecovery).toEqual({
      cycleId: "cycle-1",
      revision: 5,
      chargedAttempts: 2,
    });
    expect(project(session, current, { phase: "end" }, undefined, "drain-run")).toEqual({
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

  it.each(["end", "error"] as const)(
    "settles the current run's %s when its fence still names an older generation",
    (phase) => {
      const entry = recoveryEntry();
      entry.lifecycleRunId = "recovery";
      entry.restartRecoveryRuns = [{ runId: "recovery", lifecycleGeneration: "generation-old" }];
      expect(
        project(
          entry,
          current,
          { phase, aborted: true, stopReason: "rpc" },
          {
            status: "killed",
            abortedLastRun: true,
          },
        ),
      ).toEqual({
        action: "apply",
        patch: {
          status: "killed",
          abortedLastRun: true,
          restartRecoveryRuns: undefined,
          mainRestartRecovery: undefined,
        },
      });
    },
  );

  it.each([
    ["another current lifecycle owner", "generation-old", current, "replacement"],
    ["a consumed older fence", current, "generation-old", undefined],
  ] as const)("suppresses terminal events with %s", (_name, fence, generation, lifecycleRunId) => {
    const session = recoveryEntry({ ownsDelivery: generation === "generation-old" });
    session.lifecycleRunId = lifecycleRunId;
    session.restartRecoveryRuns = [{ runId: "recovery", lifecycleGeneration: fence }];
    expect(project(session, generation)).toEqual({ action: "suppress" });
  });
});
