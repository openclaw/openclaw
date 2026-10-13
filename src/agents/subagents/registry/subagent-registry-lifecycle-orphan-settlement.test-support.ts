/**
 * Orphan-settlement cases for the lifecycle suite: the crash-attribution
 * completion requests that originate at `reconcileStaleActiveSubagentRun` and
 * run through the real retry wrapper, admission, terminal lock and
 * terminal-effect owners.
 *
 * Kept beside the suite so the lifecycle test file stays within its line cap.
 * The `vi.mock` declarations these cases depend on are hoisted in the importing
 * test file; their hoisted state is handed in.
 */
import { expect, it, vi } from "vitest";
import type { GatewayBootLifecycleSegment } from "../../../infra/gateway-boot-lifecycle.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import {
  createRunEntry,
  readLifecycleRun,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { reconcileStaleActiveSubagentRun } from "./subagent-registry-sweeper-orphan.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";

type OrphanSettlementDeps = {
  createLifecycleController: (options: {
    entry: SubagentRunRecord;
    runs?: Map<string, SubagentRunRecord>;
    notifyContextEngineSubagentEnded?: () => Promise<void>;
    resumeSubagentRun?: () => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
  }) => SubagentLifecycleController;
  makeInterruptedSubagentCompletion: (
    entry: SubagentRunRecord,
    overrides?: Record<string, unknown>,
  ) => SubagentCompletionRequest;
  waitForLifecycleState: <T>(assertion: () => T | Promise<T>) => Promise<T>;
  orphanBootSegments: { current: GatewayBootLifecycleSegment[] };
  sessionReconciliationMocks: {
    loadSubagentSessionEntry: ReturnType<typeof vi.fn>;
    resolveSubagentRunOrphanReason: ReturnType<typeof vi.fn>;
  };
  helperMocks: {
    persistSubagentSessionTiming: ReturnType<typeof vi.fn>;
    safeRemoveAttachmentsDir: ReturnType<typeof vi.fn>;
  };
  browserLifecycleCleanupMocks: {
    cleanupBrowserSessionsForLifecycleEnd: ReturnType<typeof vi.fn>;
  };
  lifecycleEventMocks: { emitSessionLifecycleEvent: ReturnType<typeof vi.fn> };
  gatewayMocks: { callGateway: ReturnType<typeof vi.fn> };
};

const CRASHED_BOOT_HISTORY: GatewayBootLifecycleSegment[] = [
  {
    bootId: "dead",
    pid: 101,
    startedAtMs: 0,
    completedAtMs: null,
    outcome: null,
    hostBootId: null,
  },
  {
    bootId: "live",
    pid: process.pid,
    startedAtMs: 4_000,
    completedAtMs: null,
    outcome: null,
    hostBootId: null,
  },
];

export function registerOrphanSettlementCases(deps: OrphanSettlementDeps) {
  it("preserves an attributed restart error after the explicit run deadline", async () => {
    const entry = createRunEntry({ runTimeoutSeconds: 3 });
    const controller = deps.createLifecycleController({ entry });

    await controller.completeSubagentRun(
      deps.makeInterruptedSubagentCompletion(entry, {
        startedAt: 2_000,
        endedAt: 6_000,
        outcome: { status: "error", error: "gateway process exited without a clean stop" },
      }) as never,
    );

    // Terminal completion publishes a replacement row; read the published one.
    expect(readLifecycleRun(entry)).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      terminalOwner: "interrupted-recovery",
      execution: {
        endedAt: 6_000,
        outcome: {
          status: "error",
          error: "gateway process exited without a clean stop",
          startedAt: 2_000,
          endedAt: 6_000,
        },
      },
    });
  });

  // The helper, retry wrapper, admission, completion lock and terminal-effect
  // owners are real. Existing suite adapters observe task/session/transport I/O.
  // These requests originate at the orphan helper, so dropping any of its
  // bindings — row identity or execution authority — is observable here.
  it.each(
    ["persisted terminal", "attributed orphan", "lost context"].flatMap((path) =>
      ["current", "replaced", "released"].map((ownership) => ({ path, ownership })),
    ),
  )(
    "settles $path only for the $ownership entry after the terminal lock",
    async ({ path, ownership }) => {
      const entry = createRunEntry({
        generation: 1,
        cleanup: "delete",
        expectsCompletionMessage: true,
      });
      const runs = new Map([[entry.runId, entry]]);
      const successor = createRunEntry({
        generation: 2,
        createdAt: 5_000,
        execution: { status: "running", startedAt: 5_000 },
      });
      const original = structuredClone(entry);
      const successorBefore = structuredClone(successor);
      deps.orphanBootSegments.current = path === "attributed orphan" ? CRASHED_BOOT_HISTORY : [];
      deps.sessionReconciliationMocks.resolveSubagentRunOrphanReason.mockReturnValue(
        path === "attributed orphan" ? "missing-session-entry" : null,
      );
      deps.sessionReconciliationMocks.loadSubagentSessionEntry.mockReturnValue(
        path === "persisted terminal"
          ? {
              sessionId: "child-session-id",
              status: "failed",
              startedAt: 2_000,
              endedAt: 4_000,
              updatedAt: 4_000,
            }
          : undefined,
      );
      const notifyContextEngineSubagentEnded = vi.fn(async () => {});
      const resumeSubagentRun = vi.fn();
      const warn = vi.fn();
      const controller = deps.createLifecycleController({
        entry,
        runs,
        notifyContextEngineSubagentEnded,
        resumeSubagentRun,
        warn,
      });
      const retryTimers = new Set<ReturnType<typeof setTimeout>>();
      const runtime = createSubagentRegistryCompletionRuntime({
        runs,
        resumed: controller.options.resumedRuns,
        retryTimers,
        completeSubagentRun: controller.completeSubagentRun,
        scheduleSweep: vi.fn(),
        resumeRun: resumeSubagentRun,
        warn,
      });
      // Hold the actual owner's lock, not browser cleanup (which runs after it
      // is released). Observe acquisition so replacement happens while queued.
      const unlock = await controller.acquireTerminalCompletionLock(entry.runId);
      const queued = createDeferredCore();
      const acquireLock = controller.acquireTerminalCompletionLock.bind(controller);
      vi.spyOn(controller, "acquireTerminalCompletionLock").mockImplementation((runId) => {
        const result = acquireLock(runId);
        queued.resolve();
        return result;
      });
      const isSelectionCurrent = () => runs.get(entry.runId) === entry;
      // Terminal writes publish a replacement row and `cleanup: "delete"`
      // retires it, so the published owner is captured as it is published.
      let publishedTerminal: SubagentRunRecord | undefined;
      const completion = reconcileStaleActiveSubagentRun({
        runId: entry.runId,
        entry,
        now: 6_000,
        isCurrent: isSelectionCurrent,
        recoveryCurrent: {
          prepare: async () => isSelectionCurrent(),
          isHostCurrent: () => true,
          onPublished: (published) => {
            if (published.execution.status === "terminal") {
              publishedTerminal ??= published;
            }
          },
        },
        completeSubagentRunWithRecovery: runtime.completeSubagentRunWithRecovery,
      });
      try {
        await queued.promise;
        if (ownership === "replaced") {
          runs.set(entry.runId, successor);
        } else if (ownership === "released") {
          runs.delete(entry.runId);
        }
        unlock();
        await completion;
        if (ownership === "current") {
          await deps.waitForLifecycleState(() => {
            expect(deps.helperMocks.safeRemoveAttachmentsDir).toHaveBeenCalledOnce();
          });
          expect(publishedTerminal).toBeDefined();
          expect(isSameSubagentRunOwner(publishedTerminal, entry)).toBe(true);
          expect(publishedTerminal?.execution.outcome?.status).toBe("error");
          expect(deps.helperMocks.persistSubagentSessionTiming).toHaveBeenCalledOnce();
          expect(controller.options.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
          expect(
            deps.browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
          ).toHaveBeenCalledOnce();
        } else {
          expect(publishedTerminal).toBeUndefined();
          expect(runs.get(entry.runId)).toBe(ownership === "replaced" ? successor : undefined);
          expect(entry).toEqual(original);
          expect(successor).toEqual(successorBefore);
          expect(deps.helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
          expect(deps.lifecycleEventMocks.emitSessionLifecycleEvent).not.toHaveBeenCalled();
          expect(controller.options.runSubagentAnnounceFlow).not.toHaveBeenCalled();
          expect(
            deps.browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
          ).not.toHaveBeenCalled();
          expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
          expect(deps.helperMocks.safeRemoveAttachmentsDir).not.toHaveBeenCalled();
          expect(deps.gatewayMocks.callGateway).not.toHaveBeenCalled();
        }
        expect(retryTimers.size).toBe(0);
        await deps.waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      } finally {
        unlock();
        await completion;
        controller.clearScheduledResumeTimers();
        for (const timer of retryTimers) {
          clearTimeout(timer);
        }
        deps.orphanBootSegments.current = [];
        deps.sessionReconciliationMocks.resolveSubagentRunOrphanReason.mockReturnValue(null);
        vi.restoreAllMocks();
      }
    },
  );
}
