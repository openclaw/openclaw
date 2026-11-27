import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { callGateway } from "../../../gateway/call.js";
import {
  getGatewayRestartDrainSignal,
  isGatewayRestartDrainError,
  runWithGatewayDetachedWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { runInDetachedAsyncContext } from "../../../shared/detached-async-context.js";
import {
  reconcileRetiredSubagentCancellation,
  settleSubagentCompletionInHistory,
} from "../completion/subagent-completion-admission.store.js";
import { isDeliverySuspended } from "./subagent-delivery-state.js";
import type { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import { PROVISIONAL_KILL_RECONCILIATION_MS } from "./subagent-registry-helpers.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { createSubagentSweepContext } from "./subagent-registry-sweep-cleanup.js";
import {
  reconcileDurableSubagentKillIntent,
  reconcileProvisionalSubagentKill,
} from "./subagent-registry-sweep-kill.js";
import { orderSubagentSweepEntries } from "./subagent-registry-sweep-order.js";
import {
  settleRestartInterruptedSubagentRun,
  settleUnreachableYieldedSubagentRun,
} from "./subagent-registry-sweep-settle.js";
import type {
  ContextEngineSubagentEndedParams,
  SubagentRunRecord,
} from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";
import { hasSubagentRunEnded, isYieldedSubagentRun } from "./subagent-run-liveness.js";
export { retireSupersededSubagentRun } from "./subagent-registry-sweeper-retire.js";

type CompletionRuntime = ReturnType<typeof createSubagentRegistryCompletionRuntime>;

export function createSubagentRegistrySweeper(params: {
  runs: Map<string, SubagentRunRecord>;
  clearPendingLifecycleError: (runId: string) => void;
  sweepPendingLifecycle: (now: number) => void;
  completeSubagentRunWithRecovery: CompletionRuntime["completeSubagentRunWithRecovery"];
  startSubagentAnnounceCleanupFlow: SubagentLifecycleController["startSubagentAnnounceCleanupFlow"];
  resumeRequesterSettleWake: SubagentLifecycleController["resumeRequesterSettleWake"];
  resumePendingRequesterSettlements: SubagentLifecycleController["resumePendingRequesterSettlements"];
  callGateway: typeof callGateway;
  cleanupCollectorLaunchResources: (entry: SubagentRunRecord) => Promise<boolean>;
  runContextEngineSubagentEnded: (params: ContextEngineSubagentEndedParams) => Promise<void>;
  notifyContextEngineSubagentEnded: (params: ContextEngineSubagentEndedParams) => Promise<void>;
  retireSupersededRun: (runId: string, entry: SubagentRunRecord) => Promise<void>;
  retireObligations: (entry: SubagentRunRecord) => Promise<void>;
  getRunsForChildSession: (
    childSessionKey: string,
    childAgentId?: string,
  ) => Iterable<SubagentRunRecord>;
  getRunsForCollectorGroup: (
    requesterSessionKey: string,
    groupId: string,
    requesterAgentId?: string,
  ) => Iterable<[string, SubagentRunRecord]>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}) {
  const { runs } = params;
  let intervalStarted = false;
  let scheduled: { timer: NodeJS.Timeout; at: number } | undefined;
  let sweepInProgress = false;
  let rerunRequested = false;
  const pendingWork = new Set<Promise<unknown>>();

  function trackWork<T>(run: () => Promise<T>): Promise<T> {
    const pending = run();
    pendingWork.add(pending);
    const settled = () => pendingWork.delete(pending);
    void pending.then(settled, settled);
    return pending;
  }

  function start() {
    if (!intervalStarted) {
      intervalStarted = true;
      schedule({ delayMs: 60_000 });
    }
  }

  function stop() {
    intervalStarted = false;
    clearTimeout(scheduled?.timer);
    scheduled = undefined;
    rerunRequested = false;
  }

  function stopIfIdle() {
    const pendingRequesterSettlements = params.resumePendingRequesterSettlements();
    if (runs.size === 0 && !pendingRequesterSettlements) {
      stop();
    }
  }

  function schedule(options?: { delayMs?: number }) {
    const delayMs = Math.max(0, options?.delayMs ?? 5_000);
    const nextAt = Date.now() + delayMs;
    if (scheduled && scheduled.at <= nextAt) {
      return;
    }
    clearTimeout(scheduled?.timer);
    const timer = runInDetachedAsyncContext(() =>
      setTimeout(() => {
        scheduled = undefined;
        void trackWork(runTick);
      }, delayMs),
    );
    timer.unref();
    scheduled = { timer, at: nextAt };
  }

  async function runTick() {
    if (sweepInProgress) {
      rerunRequested = true;
      return;
    }
    try {
      await runWithGatewayDetachedWorkAdmission(() => sweepOnce(), "subagents:sweeper");
    } catch (error) {
      if (isGatewayRestartDrainError(error)) {
        return params.warn("subagent run sweep skipped: gateway is draining for restart");
      }
      params.warn(
        `subagent run sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (rerunRequested) {
      rerunRequested = false;
      schedule({ delayMs: 0 });
    } else if (intervalStarted) {
      schedule({ delayMs: 60_000 });
    }
  }

  function runCleanupTail(runId: string, label: string, run: () => Promise<unknown>) {
    // Cleanup can outlive the tick as well as the request that armed its timer.
    void trackWork(() =>
      runWithGatewayDetachedWorkAdmission(run, "subagents:sweeper-cleanup").catch(
        (error: unknown) => params.warn(`subagent sweep ${label} failed`, { runId, error }),
      ),
    );
  }

  async function sweepOnce() {
    if (sweepInProgress) {
      return;
    }
    sweepInProgress = true;
    const drainSignal = getGatewayRestartDrainSignal();
    try {
      const now = Date.now();
      const runEntries = orderSubagentSweepEntries(runs, now);
      if (runEntries.length === 0) {
        params.sweepPendingLifecycle(now);
        stopIfIdle();
        return;
      }
      const readScope = createSubagentSweepContext(
        runs,
        { ...params, runCleanupTail },
        now,
        drainSignal,
      );
      readScope.prepareCleanup(runEntries);
      let yieldAt = performance.now() + 4;
      let visited = 0;
      for (const [runId, snapshot] of runEntries) {
        // Break resolved-promise drains without yielding for every cheap batch.
        if (++visited % 128 === 0 && performance.now() >= yieldAt) {
          await yieldToEventLoop();
          yieldAt = performance.now() + 4;
        }
        // Finish admitted cleanup, but leave the remaining durable backlog for the next Gateway.
        if (drainSignal.aborted) {
          return;
        }
        readScope.assertCurrent();
        const selected = runs.get(runId);
        if (!selected || !isSameSubagentRunOwner(selected, snapshot)) {
          continue;
        }
        if (
          selected.killReconciliation &&
          (await reconcileRetiredSubagentCancellation(selected, now)) === false
        ) {
          continue;
        }
        const reconciled = runs.get(runId);
        if (!reconciled || !isSameSubagentRunOwner(reconciled, selected)) {
          continue;
        }
        const entry = reconciled;
        // A yielded run no continuation can reach settles instead of parking forever.
        const executionRetired = subagentRuns.isCompletionAuthorityRetired(entry);
        if (
          isYieldedSubagentRun(entry) &&
          (await settleUnreachableYieldedSubagentRun({
            runId,
            entry,
            readScope,
            complete: params.completeSubagentRunWithRecovery,
          }))
        ) {
          continue;
        }
        if (isDeliverySuspended(entry)) {
          // Older builds parked this result. Settle it into requester history once, then
          // finish cleanup as delivered.
          if (await settleSubagentCompletionInHistory({ subagent: entry })) {
            params.startSubagentAnnounceCleanupFlow(runs.get(runId) ?? entry);
          }
          continue;
        }
        // Retry live receipts even when the last child has already settled.
        // The lifecycle and controller still own evaluation and turn admission.
        if (
          !executionRetired &&
          entry.requesterSettleWake &&
          entry.execution.status !== "running" &&
          hasSubagentRunEnded(entry)
        ) {
          params.resumeRequesterSettleWake(runId, entry);
          continue;
        }
        if (!executionRetired && entry.killIntent) {
          await reconcileDurableSubagentKillIntent({
            ...params,
            runId,
            entry,
          });
          continue;
        }
        if (!executionRetired && entry.killReconciliation) {
          // Live operation settlement confirms kills immediately; this is the dormant fallback.
          if (entry.killReconciliation.killedAt + PROVISIONAL_KILL_RECONCILIATION_MS <= now) {
            await reconcileProvisionalSubagentKill({
              ...params,
              runId,
              entry,
              now,
            });
          }
          continue;
        }
        if (typeof entry.execution.endedAt !== "number") {
          // A running row from an earlier process never resumes; its requester still
          // needs a terminal outcome. Any other unended row is retained history.
          await settleRestartInterruptedSubagentRun({
            runId,
            entry,
            readScope,
            complete: params.completeSubagentRunWithRecovery,
            now,
          });
          continue;
        }

        await readScope.sweepRun(runId, entry);
      }
      if (!(await readScope.sweepCollectorGroups())) {
        return;
      }
      params.sweepPendingLifecycle(now);

      stopIfIdle();
    } finally {
      sweepInProgress = false;
    }
  }

  return {
    start,
    stop,
    stopIfIdle,
    schedule,
    sweepOnce: () => trackWork(sweepOnce),
    runTick: () => trackWork(runTick),
    async reset() {
      stop();
      // Accepted sweeps can start cleanup tails before they settle.
      while (pendingWork.size > 0) {
        await Promise.allSettled(pendingWork);
      }
    },
  };
}
