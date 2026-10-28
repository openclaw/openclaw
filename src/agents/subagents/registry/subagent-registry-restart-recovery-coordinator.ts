import pLimit from "p-limit";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import type { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import { getRecordedSubagentChildAuthority } from "./subagent-registry-memory.js";
import { SubagentRegistryMutationRejectedError } from "./subagent-registry-persistence.js";
import { getLatestSubagentRunForChild } from "./subagent-registry-queries.js";
import type {
  RestartRecoveryParams,
  RestartRecoveryResult,
} from "./subagent-registry-restart-recovery-types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";

export function createInterruptedRecoveryCoordinator(params: {
  runs: Map<string, SubagentRunRecord>;
  getRunsForChildSession: (
    childSessionKey: string,
    childAgentId?: string,
  ) => Iterable<SubagentRunRecord>;
  getGatewayRuntime: () => GatewayRecoveryRuntime | undefined;
  finalizeRun: ReturnType<
    typeof createSubagentRegistryCompletionRuntime
  >["finalizeInterruptedSubagentRun"];
  isTerminalTailActive: (entry: SubagentRunRecord) => boolean;
  recoverRow: (params: RestartRecoveryParams) => Promise<RestartRecoveryResult>;
  schedule: (delayMs: number) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}) {
  type Attempt = {
    delayMs: number;
    retryAt?: number;
    retained?: Extract<RestartRecoveryResult, { status: "handled" }>["retained"];
  };
  const attempts = new Map<string, Attempt>();
  const recovering = new Set<object>();
  const limitRecovery = pLimit(8);
  let warnedRetainedOwners = new WeakSet<object>();
  let stopObservingRunOwners: (() => void) | undefined;
  const retryRetainedOwner = (runId: string, attempt: Attempt) => {
    if (attempts.get(runId) === attempt) {
      attempts.delete(runId);
      params.schedule(1_000);
    }
  };
  const observeRetainedRunOwners = () => {
    stopObservingRunOwners ??= sessionChanges.subscribe((change) => {
      if ("all" in change ? change.scope !== "agent-runs" : change.scope !== "runtime") {
        return;
      }
      const entries =
        "sessionKey" in change
          ? params.getRunsForChildSession(change.sessionKey, change.agentId)
          : params.runs.values();
      for (const entry of entries) {
        const attempt = attempts.get(entry.runId);
        if (attempt?.retained && !attempt.retained.isCurrent()) {
          retryRetainedOwner(entry.runId, attempt);
        }
      }
    });
  };
  const recoveryFacts = (entry: SubagentRunRecord) => [
    getSubagentRunRuntimeKey(entry),
    entry.execution.status,
    entry.execution.startedAt,
    entry.execution.endedAt,
    entry.execution.lifecycleGeneration,
    JSON.stringify(entry.execution.restartRecovery),
    entry.pauseReason,
    JSON.stringify(entry.killIntent),
    JSON.stringify(entry.killReconciliation),
    entry.suppressAnnounceReason,
    entry.terminalOwner,
  ];
  const ownsRow = (runId: string, entry: SubagentRunRecord) => {
    const current = params.runs.get(runId);
    const expected = recoveryFacts(entry);
    return (
      current !== undefined &&
      isSameSubagentRunOwner(current, entry) &&
      recoveryFacts(current).every((fact, index) => fact === expected[index]) &&
      // A saved terminal result still owes delivery after its child session is reused.
      // Only unfinished execution needs the latest generation's session ownership.
      ((entry.execution.status === "terminal" && entry.terminalOwner === "interrupted-recovery") ||
        isSameSubagentRunOwner(
          getLatestSubagentRunForChild(
            params.getRunsForChildSession(entry.childSessionKey, entry.childAgentId),
            entry,
          ),
          entry,
        ))
    );
  };

  return {
    prune() {
      for (const runId of attempts.keys()) {
        if (!params.runs.has(runId)) {
          attempts.delete(runId);
        }
      }
    },
    reset() {
      stopObservingRunOwners?.();
      stopObservingRunOwners = undefined;
      attempts.clear();
      warnedRetainedOwners = new WeakSet();
    },
    async recover(runId: string, entry: SubagentRunRecord): Promise<boolean> {
      const authority = getRecordedSubagentChildAuthority(entry);
      if (authority.status === "mismatch") {
        const owner = getSubagentRunRuntimeKey(entry);
        if (!warnedRetainedOwners.has(owner)) {
          warnedRetainedOwners.add(owner);
          params.warn("retained subagent record cannot be recovered", {
            runId,
            childSessionKey: entry.childSessionKey,
            error: new Error(authority.error),
          });
        }
        return true;
      }
      if (
        entry.execution.restartRecovery === undefined &&
        (entry.terminalOwner !== "interrupted-recovery" ||
          typeof entry.cleanupCompletedAt === "number") &&
        (getAgentRunContext(runId) || typeof entry.execution.endedAt === "number")
      ) {
        return false;
      }
      if (entry.execution.status === "terminal" && params.isTerminalTailActive(entry)) {
        // Replay drains orphaned winners; this process is still draining this one.
        return true;
      }
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const gatewayRuntime = params.getGatewayRuntime();
      const isGatewayCurrent = () =>
        isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) &&
        params.getGatewayRuntime() === gatewayRuntime;
      const isCurrent = (targetRunId: string, candidate: SubagentRunRecord) =>
        isGatewayCurrent() && ownsRow(targetRunId, candidate);
      if (!isCurrent(runId, entry)) {
        attempts.delete(entry.runId);
        // Superseded rows still belong to the sweeper's ordinary orphan cleanup.
        return false;
      }
      const owner = getSubagentRunRuntimeKey(entry);
      if (recovering.has(owner)) {
        return true;
      }
      recovering.add(owner);
      let releaseRecovery: (() => void) | undefined;
      try {
        return await limitRecovery(async () => {
          if (!isCurrent(runId, entry)) {
            return true;
          }
          const preparation = gatewayRuntime?.prepareRestartRecovery();
          if (preparation) {
            const pausedUntilMs = await preparation;
            if (!isCurrent(runId, entry)) {
              return true;
            }
            if (pausedUntilMs !== undefined) {
              params.schedule(Math.max(1, pausedUntilMs - Date.now()));
              return true;
            }
          }
          const previous = attempts.get(entry.runId);
          if (previous?.retained?.isCurrent()) {
            return true;
          }
          if (previous?.retryAt !== undefined && previous.retryAt > Date.now()) {
            params.schedule(previous.retryAt - Date.now());
            return true;
          }
          const result = await params.recoverRow({
            runId,
            entry,
            gatewayRuntime,
            isCurrent,
            isGatewayCurrent,
            warn: params.warn,
          });
          releaseRecovery = result.status === "terminal" ? result.release : undefined;
          if (!isGatewayCurrent() || !isSameSubagentRunOwner(params.runs.get(runId), entry)) {
            return true;
          }
          attempts.delete(entry.runId);
          if (result.status === "ignored" || result.status === "handled") {
            if (result.status === "handled" && result.retained) {
              const attempt = { delayMs: 0, retained: result.retained };
              attempts.set(entry.runId, attempt);
              // Admission can release before the run context finishes its cleanup.
              observeRetainedRunOwners();
              if (!result.retained.isCurrent()) {
                retryRetainedOwner(entry.runId, attempt);
              }
              const resume = () => retryRetainedOwner(entry.runId, attempt);
              void result.retained.released?.then(resume, resume);
            }
            return result.status === "handled";
          }
          if (result.status === "deferred") {
            const delayMs = Math.min(60_000, Math.max(1_000, (previous?.delayMs ?? 0) * 2));
            attempts.set(entry.runId, {
              delayMs,
              retryAt: Date.now() + delayMs,
            });
            params.schedule(delayMs);
            return true;
          }
          if (!isCurrent(runId, entry)) {
            return true;
          }
          let expectedObservation = entry;
          const finalized = await params.finalizeRun({
            runId,
            expectedEntry: entry,
            recoveryCurrent: {
              isHostCurrent: () =>
                isCurrent(runId, expectedObservation) &&
                result.recoveryCurrent?.isHostCurrent() !== false,
              prepare: async () =>
                isCurrent(runId, expectedObservation) &&
                (await result.recoveryCurrent?.prepare()) !== false &&
                isCurrent(runId, expectedObservation) &&
                result.recoveryCurrent?.isHostCurrent() !== false,
              onPublished: (published) => {
                if (
                  !isSameSubagentRunOwner(published, entry) ||
                  published.execution.status !== "terminal"
                ) {
                  throw new SubagentRegistryMutationRejectedError(
                    "Subagent recovery publication changed its execution owner",
                  );
                }
                result.recoveryCurrent?.onPublished?.(published);
                expectedObservation = published;
              },
            },
            sessionEffects: result.sessionEffects,
            error: result.error,
            terminalStatus: result.terminalStatus,
            endedAt: result.endedAt,
            suppressSessionEffects: result.suppressSessionEffects,
          });
          if (!isCurrent(runId, expectedObservation)) {
            return true;
          }
          if (!finalized) {
            params.schedule(1_000);
          }
          return true;
        });
      } finally {
        releaseRecovery?.();
        // Reset retires observations, but accepted recovery keeps its exclusion until settled.
        recovering.delete(owner);
      }
    },
  };
}
