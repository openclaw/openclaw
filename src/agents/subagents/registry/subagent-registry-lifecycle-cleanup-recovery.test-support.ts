/**
 * Lifecycle hardening cases for failed-cleanup retry generations and
 * interrupted-restart recovery.
 *
 * Extracted from subagent-registry-lifecycle.test.ts so that file stays under
 * its line cap. The mock-bound fixture builders stay with the suite that
 * declares the mocks and arrive through the register hook, so these cases run
 * against exactly the same module graph they did inline.
 */
import { expect, it, type Mock, vi } from "vitest";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { resolveSubagentRunDisposition } from "../subagent-terminal-outcome.js";
import {
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import { registerDeliveryRetryOwnerTests } from "./subagent-registry-lifecycle-cleanup.test-support.js";
import { registerRequesterSettleRetirementTests } from "./subagent-registry-lifecycle-completion.test-support.js";
import {
  createLifecycleControllerFixture,
  createRunEntry,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import {
  readLifecycleRun,
  type RunEntryOverrides,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import {
  completeRun,
  makeInterruptedSubagentCompletion,
  makeKilledSubagentCompletion,
  makeSubagentCompletion,
  waitForLifecycleState,
} from "./subagent-registry-lifecycle.fixtures.test-support.js";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "./subagent-registry-read.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-pause.js";
import { registerTerminalStateSignalAuthorityTests } from "./subagent-registry-terminal-state.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type CleanupRecoveryFixture = {
  createLifecycleController: (
    params: Parameters<typeof createLifecycleControllerFixture>[0],
  ) => ReturnType<typeof createLifecycleControllerFixture>;
  createCaptureFixture: (entry?: SubagentRunRecord) => {
    entry: SubagentRunRecord;
    runs: Map<string, SubagentRunRecord>;
    captured: ReturnType<typeof createDeferredCore<string>>;
    captureSubagentCompletionReply: Mock;
    controller: SubagentLifecycleController;
  };
  completionDeliveryMocks: {
    blockSubagentCompletionDelivery: Mock;
    mutateRequesterCompletionBatch: Mock;
    ownersByEntry: Map<object, Pick<SubagentLifecycleOptions, "runs">>;
  };
  helperMocks: {
    persistSubagentSessionTiming: Mock;
    safeRemoveAttachmentsDir: Mock;
    logAnnounceGiveUp: Mock;
  };
  lifecycleEventMocks: { emitSessionLifecycleEvent: Mock };
};

export function registerLifecycleCleanupRetryAndRecoveryTests({
  createLifecycleController,
  createCaptureFixture,
  completionDeliveryMocks,
  helperMocks,
  lifecycleEventMocks,
}: CleanupRecoveryFixture) {
  it.each([
    { phase: "backoff", related: false },
    { phase: "backoff", related: true },
    { phase: "exhaustion", related: false },
    { phase: "exhaustion", related: true },
  ])(
    "preserves cleanup $phase when another run settles (related=$related)",
    async ({ phase, related }) => {
      vi.useFakeTimers();
      const entry = createRunEntry({
        endedAt: Date.now() - 1_000,
        expectsCompletionMessage: false,
        retainAttachmentsOnKeep: false,
      });
      const runs = new Map([[entry.runId, entry]]);
      helperMocks.safeRemoveAttachmentsDir.mockRejectedValue(new Error("cleanup failed"));
      const controller = createLifecycleController({
        entry,
        runs,
        resumeSubagentRun: (runId) => {
          const current = runs.get(runId);
          if (current) {
            controller.startSubagentAnnounceCleanupFlow(current);
          }
        },
      });

      try {
        controller.startSubagentAnnounceCleanupFlow(entry);
        await waitForLifecycleState(() =>
          expect(readLifecycleRun(entry).cleanupHandled).toBe(false),
        );
        if (phase === "exhaustion") {
          for (let retry = 0; retry < 3; retry += 1) {
            await vi.runOnlyPendingTimersAsync();
          }
        }
        const attempts = phase === "exhaustion" ? 4 : 1;
        expect(helperMocks.safeRemoveAttachmentsDir).toHaveBeenCalledTimes(attempts);

        for (let index = 0; index < 3; index += 1) {
          const settled = createRunEntry({
            runId: `settled-${index}`,
            childSessionKey: `agent:main:subagent:settled-${index}`,
            requesterSessionKey: related ? entry.childSessionKey : "agent:other:main",
            endedAt: Date.now(),
            expectsCompletionMessage: false,
            retainAttachmentsOnKeep: true,
          });
          runs.set(settled.runId, settled);
          controller.startSubagentAnnounceCleanupFlow(settled);
          await waitForLifecycleState(() =>
            expect(readLifecycleRun(settled).cleanupCompletedAt).toBeTypeOf("number"),
          );
          await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        }

        expect(helperMocks.safeRemoveAttachmentsDir).toHaveBeenCalledTimes(attempts);
        expect(readLifecycleRun(entry).cleanupHandled).toBe(false);
        expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
        if (phase === "backoff") {
          await vi.advanceTimersByTimeAsync(1_000);
          expect(helperMocks.safeRemoveAttachmentsDir).toHaveBeenCalledTimes(2);
        } else {
          expect(vi.getTimerCount()).toBe(0);
        }
      } finally {
        helperMocks.safeRemoveAttachmentsDir.mockReset().mockResolvedValue(undefined);
        controller.clearScheduledResumeTimers();
        vi.useRealTimers();
      }
    },
  );

  it("hands a failed cleanup retry to descendant settlement after a late empty final", async () => {
    vi.useFakeTimers();
    const entry = createRunEntry({
      endedAt: Date.now() - 1_000,
      expectsCompletionMessage: true,
      wakeOnDescendantSettle: true,
      outcome: { status: "ok" },
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      delivery: { status: "pending", deadlineAt: Date.now() - 1 },
      retainAttachmentsOnKeep: true,
    });
    const child = createRunEntry({
      runId: "pending-descendant",
      childSessionKey: "agent:main:subagent:pending-descendant",
      requesterSessionKey: entry.childSessionKey,
      endedAt: Date.now(),
      expectsCompletionMessage: false,
    });
    const runs = new Map([
      [entry.runId, entry],
      [child.runId, child],
    ]);
    let pendingDescendants = 1;
    completionDeliveryMocks.blockSubagentCompletionDelivery.mockRejectedValueOnce(
      new Error("completion suspension transaction failed"),
    );
    const controller = createLifecycleController({
      entry,
      runs,
      countPendingDescendantRuns: async () => pendingDescendants,
      runSubagentAnnounceFlow: vi.fn(async () => "retryable" as const),
      resumeSubagentRun: (runId) => {
        const current = runs.get(runId);
        if (current) {
          controller.startSubagentAnnounceCleanupFlow(current);
        }
      },
    });

    try {
      controller.startSubagentAnnounceCleanupFlow(entry);
      await waitForLifecycleState(() => expect(readLifecycleRun(entry).cleanupHandled).toBe(false));
      expect(completionDeliveryMocks.blockSubagentCompletionDelivery).toHaveBeenCalledOnce();
      await completeRun(controller, entry, {
        endedAt: Date.now(),
        outcome: { status: "ok" },
        terminalReply: { disposition: "empty" },
        triggerCleanup: false,
      });
      expect(readLifecycleRun(entry).suppressCompletionDelivery).toBe(true);
      expect(readLifecycleRun(entry).wakeOnDescendantSettle).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
      pendingDescendants = 0;
      await controller.completeCleanupBookkeeping({
        runId: child.runId,
        entry: child,
        cleanup: "keep",
        completedAt: Date.now(),
        preserveTranscript: true,
        skipRequesterSettleWake: true,
      });
      await waitForLifecycleState(() =>
        expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number"),
      );
    } finally {
      controller.clearScheduledResumeTimers();
      vi.useRealTimers();
    }
  });

  registerRequesterSettleRetirementTests({
    createRunEntry,
    createLifecycleController,
    waitForLifecycleState,
    completeRun,
  });

  it("keeps a same-run replacement from hiding another session successor", () => {
    const entry = createRunEntry({
      runId: "fence-original",
      childSessionKey: "agent:main:subagent:fence-index",
      generation: 1,
    });
    const replacement = createRunEntry({ ...entry, generation: 3 });
    const successor = createRunEntry({ ...entry, runId: "fence-successor", generation: 2 });
    subagentRuns.set(replacement.runId, replacement);
    subagentRuns.set(successor.runId, successor);
    const controller = createLifecycleController({
      entry,
      runs: subagentRuns,
      getLatestRunForChildSession: getLatestLiveSubagentRunByChildSessionKey,
    });

    try {
      expect(controller.newerGenerationOwnsSession(entry)).toBe(true);
      subagentRuns.delete(successor.runId);
      expect(controller.newerGenerationOwnsSession(entry)).toBe(false);
      subagentRuns.set(successor.runId, { ...successor, generation: 0, createdAt: 0 });
      expect(controller.newerGenerationOwnsSession(entry)).toBe(false);
      entry.killReconciliation = { killedAt: 1, supersededAt: 2 };
      expect(controller.newerGenerationOwnsSession(entry)).toBe(true);
    } finally {
      subagentRuns.delete(replacement.runId);
      subagentRuns.delete(successor.runId);
    }
  });

  it.each([false, true])(
    "resumes only current ancestors after retirement (cycle=%s)",
    async (cycle) => {
      const ancestor = createRunEntry({
        runId: "ancestor-current",
        childSessionKey: "agent:main:subagent:ancestor",
        requesterSessionKey: cycle ? "agent:main:subagent:parent" : "agent:main:main",
        generation: 2,
        endedAt: Date.now(),
        expectsCompletionMessage: true,
        pauseReason: "sessions_yield",
        wakeOnDescendantSettle: true,
      });
      const previous = createRunEntry({ ...ancestor, runId: "ancestor-previous", generation: 1 });
      const parent = createRunEntry({
        runId: "parent",
        childSessionKey: "agent:main:subagent:parent",
        requesterSessionKey: ancestor.childSessionKey,
        endedAt: Date.now(),
        cleanupCompletedAt: Date.now(),
      });
      const settled = createRunEntry({
        runId: "settled",
        requesterSessionKey: parent.childSessionKey,
        endedAt: Date.now(),
      });
      const unrelated = createRunEntry({
        runId: "unrelated",
        childSessionKey: "agent:main:subagent:unrelated",
        endedAt: Date.now(),
      });
      const runs = new Map(
        [ancestor, previous, parent, settled, unrelated].map((entry) => [entry.runId, entry]),
      );
      const resumeSubagentRun = vi.fn();
      const controller = createLifecycleController({ entry: settled, runs, resumeSubagentRun });

      await controller.completeCleanupBookkeeping({
        runId: settled.runId,
        entry: settled,
        cleanup: "delete",
        completedAt: Date.now(),
        preserveTranscript: true,
        skipRequesterSettleWake: true,
      });

      expect(runs.has(settled.runId)).toBe(false);
      expect(resumeSubagentRun).toHaveBeenCalledExactlyOnceWith(ancestor.runId);
    },
  );

  it("drops a failed-cleanup retry after a newer cleanup generation starts", async () => {
    vi.useFakeTimers();
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: false,
      retainAttachmentsOnKeep: false,
    });
    let releaseNewCleanup: (() => void) | undefined;
    helperMocks.safeRemoveAttachmentsDir
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseNewCleanup = resolve;
          }),
      );
    const resumeSubagentRun = vi.fn();
    const controller = createLifecycleController({ entry, resumeSubagentRun });

    try {
      expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
      await waitForLifecycleState(() => expect(readLifecycleRun(entry).cleanupHandled).toBe(false));
      expect(vi.getTimerCount()).toBe(1);

      expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
      await waitForLifecycleState(() => expect(releaseNewCleanup).toBeTypeOf("function"));
      await vi.advanceTimersByTimeAsync(1_000);

      expect(resumeSubagentRun).not.toHaveBeenCalled();
      releaseNewCleanup?.();
      await waitForLifecycleState(() =>
        expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number"),
      );
    } finally {
      releaseNewCleanup?.();
      controller.clearScheduledResumeTimers();
      vi.useRealTimers();
    }
  });

  registerDeliveryRetryOwnerTests({
    createRunEntry,
    createLifecycleController,
    helperMocks,
    waitForLifecycleState,
  });

  registerTerminalStateSignalAuthorityTests({
    createRunEntry,
    createLifecycleController,
    completeRun,
    helperMocks,
    lifecycleEventMocks,
  });

  it.each(["ordinary", "interrupted"] as const)(
    "restores the registry state when %s completion persistence fails",
    async (source) => {
      const entry = createRunEntry();
      const original = structuredClone(entry);
      const controller = createLifecycleController({
        entry,
        beforeWrite: () => {
          throw new Error("registry store boom");
        },
      });

      await expect(
        controller.completeSubagentRun(
          source === "interrupted"
            ? makeInterruptedSubagentCompletion(entry)
            : makeSubagentCompletion(entry),
        ),
      ).rejects.toThrow("registry store boom");
      expect(readLifecycleRun(entry)).toEqual(original);
    },
  );

  it.each(["interrupted", "killed"] as const)(
    "keeps provider success canonical while a %s callback waits behind capture",
    async (source) => {
      const { entry, controller, captured, captureSubagentCompletionReply } = createCaptureFixture(
        createRunEntry({ expectsCompletionMessage: source === "killed" ? false : undefined }),
      );
      const success = completeRun(controller, entry);
      await waitForLifecycleState(() =>
        expect(captureSubagentCompletionReply).toHaveBeenCalledOnce(),
      );
      const competing = controller.completeSubagentRun(
        source === "interrupted"
          ? makeInterruptedSubagentCompletion(entry, { endedAt: 4_001 })
          : makeKilledSubagentCompletion(entry, { endedAt: 4_001 }),
      );
      const reply = source === "interrupted" ? "provider result" : "Canonical final reply.";
      captured.resolve(reply);
      await Promise.all([success, competing]);

      expect(readLifecycleRun(entry)).toMatchObject({
        endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
        execution: { endedAt: 4_000, outcome: { status: "ok" } },
        completion: { resultText: reply },
      });
      expect(readLifecycleRun(entry).terminalOwner).toBeUndefined();
    },
  );

  it("persists interrupted recovery before task projection and rejects late provider or yield", async () => {
    const entry = createRunEntry();
    const beforeWrite = vi.fn();
    const controller = createLifecycleController({ entry, beforeWrite });
    await controller.completeSubagentRun(makeInterruptedSubagentCompletion(entry));
    const recovered = structuredClone(readLifecycleRun(entry));

    await completeRun(controller, entry, { endedAt: 4_001 });

    expect(
      markSubagentRunPausedAfterYield({
        entry: structuredClone(readLifecycleRun(entry)),
        endedAt: 4_002,
      }),
    ).toBe(false);
    expect(readLifecycleRun(entry)).toEqual(recovered);
    expect(readLifecycleRun(entry)).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      terminalOwner: "interrupted-recovery",
      execution: {
        endedAt: 4_000,
        outcome: { status: "error", error: "restart interrupted run" },
      },
      completion: { resultText: null, capturedAt: 4_000 },
    });
    expect(beforeWrite).toHaveBeenCalledOnce();
  });

  it.each([
    ["provisional", { killReconciliation: { killedAt: 4_000 } }],
    ["stable", {}],
  ])("keeps %s killed state unchanged during interrupted recovery", async (_name, extra) => {
    const entry = createRunEntry({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" },
      suppressAnnounceReason: "killed",
      ...extra,
    });
    const original = structuredClone(entry);
    const beforeWrite = vi.fn();
    await createLifecycleController({ entry, beforeWrite }).completeSubagentRun(
      makeInterruptedSubagentCompletion(entry, {
        endedAt: 4_001,
      }),
    );

    expect(readLifecycleRun(entry)).toEqual(original);
    expect(beforeWrite).not.toHaveBeenCalled();
  });

  it("does not overwrite partial terminal evidence during interrupted recovery", async () => {
    const terminalEvidence: RunEntryOverrides[] = [
      { execution: { status: "terminal", endedAt: 4_000 } },
      {
        execution: {
          status: "terminal",
          outcome: { status: "error", error: "existing failure" },
        },
      },
      { endedReason: SUBAGENT_ENDED_REASON_ERROR },
      {
        execution: {
          status: "terminal",
          endedAt: 4_000,
          outcome: { status: "error", error: "existing failure" },
        },
        endedReason: SUBAGENT_ENDED_REASON_ERROR,
      },
    ];
    for (const evidence of terminalEvidence) {
      const entry = createRunEntry(evidence);
      const original = structuredClone(entry);
      const beforeWrite = vi.fn();
      await createLifecycleController({ entry, beforeWrite }).completeSubagentRun(
        makeInterruptedSubagentCompletion(entry, {
          endedAt: 4_001,
        }),
      );

      expect(readLifecycleRun(entry)).toEqual(original);
      expect(beforeWrite).not.toHaveBeenCalled();
    }
  });

  it("drains exact interrupted terminal evidence after restart admission reopens", async () => {
    const interruptedOutcome = {
      status: "error" as const,
      error: "restart interrupted run",
      startedAt: 2_000,
      endedAt: 4_000,
      elapsedMs: 2_000,
    };
    const entry = createRunEntry({
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      execution: {
        status: "terminal",
        startedAt: 2_000,
        endedAt: 4_000,
        outcome: interruptedOutcome,
      },
    });
    const beforeWrite = vi.fn();
    await createLifecycleController({ entry, beforeWrite }).completeSubagentRun(
      makeInterruptedSubagentCompletion(entry),
    );

    expect(readLifecycleRun(entry)).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      terminalOwner: "interrupted-recovery",
      execution: {
        status: "terminal",
        endedAt: 4_000,
        outcome: { status: "error", error: "restart interrupted run" },
      },
    });
  });

  // Every cancellation producer other than the entry.killIntent path reaches
  // this boundary with the killed reason and no disposition. The default read
  // of an absent disposition is `exited`, so each of these used to publish
  // `exited` for a child that was killed.
  it.each([
    {
      label: "the wait manager's cancellation completion",
      outcome: { status: "error", error: "agent run aborted" } as const,
    },
    {
      label: "the pending lifecycle scheduler's cancellation completion",
      outcome: { status: "error", error: "killed" } as const,
    },
    {
      label: "persisted killed-session reconciliation",
      outcome: { status: "error", error: "subagent run terminated" } as const,
    },
  ])("stamps killed disposition for $label", async ({ outcome }) => {
    const entry = createRunEntry();
    const controller = createLifecycleController({ entry });

    await controller.completeSubagentRun(makeKilledSubagentCompletion(entry, { outcome }));

    // Completion publishes a new row rather than mutating `entry` in place, so
    // the assertions read the published owner.
    const published = readLifecycleRun(entry);
    expect(published.endedReason).toBe(SUBAGENT_ENDED_REASON_KILLED);
    expect(published.execution.outcome).toMatchObject({ ...outcome, disposition: "killed" });
    expect(resolveSubagentRunDisposition(published.execution.outcome)).toBe("killed");
  });

  it("replaces a provisional still-running disposition on a cancellation completion", async () => {
    const entry = createRunEntry();
    const controller = createLifecycleController({ entry });

    await controller.completeSubagentRun(
      makeKilledSubagentCompletion(entry, {
        // A wait-expiry publication describes the waiter, not the run. Carrying
        // it onto a cancellation would tell the parent a killed child is still
        // live and harvestable.
        outcome: { status: "error", error: "agent run aborted", disposition: "still-running" },
      }),
    );

    expect(resolveSubagentRunDisposition(readLifecycleRun(entry).execution.outcome)).toBe("killed");
  });
}
