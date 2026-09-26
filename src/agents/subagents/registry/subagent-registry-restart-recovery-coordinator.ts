import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import type { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import { getLatestSubagentRunByChildSessionKeyFromRuns } from "./subagent-registry-queries.js";
import type {
  RestartRecoveryParams,
  RestartRecoveryResult,
} from "./subagent-registry-restart-recovery.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function createInterruptedRecoveryCoordinator(params: {
  runs: Map<string, SubagentRunRecord>;
  getRunsForChildSession: (childSessionKey: string) => Iterable<SubagentRunRecord>;
  getGatewayRuntime: () => GatewayRecoveryRuntime | undefined;
  finalizeRun: ReturnType<
    typeof createSubagentRegistryCompletionRuntime
  >["finalizeInterruptedSubagentRun"];
  recoverRow: (params: RestartRecoveryParams) => Promise<RestartRecoveryResult>;
  schedule: (delayMs: number) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}) {
  type Attempt = {
    facts: unknown[];
    delayMs: number;
    retryAt?: number;
    retained?: Extract<RestartRecoveryResult, { status: "handled" }>["retained"];
  };
  let attempts = new WeakMap<SubagentRunRecord, Attempt>();
  let unsubscribe: (() => void) | undefined;
  const invalidate = (entry: SubagentRunRecord) => {
    if (attempts.delete(entry)) {
      params.schedule(1_000);
    }
  };
  const observe = () => {
    unsubscribe ??= sessionChanges.subscribe((change) => {
      if ("sessionKey" in change) {
        for (const entry of params.getRunsForChildSession(change.sessionKey)) {
          invalidate(entry);
        }
      } else {
        for (const entry of params.runs.values()) {
          invalidate(entry);
        }
      }
    });
  };
  const ownsRow = (runId: string, entry: SubagentRunRecord) =>
    params.runs.get(runId) === entry &&
    getLatestSubagentRunByChildSessionKeyFromRuns(
      params.getRunsForChildSession(entry.childSessionKey),
      entry.childSessionKey,
    ) === entry;

  return {
    reset() {
      unsubscribe?.();
      unsubscribe = undefined;
      attempts = new WeakMap();
    },
    async recover(runId: string, entry: SubagentRunRecord): Promise<boolean> {
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const gatewayRuntime = params.getGatewayRuntime();
      const isGatewayCurrent = () =>
        isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) &&
        params.getGatewayRuntime() === gatewayRuntime;
      const isCurrent = (targetRunId: string, candidate: SubagentRunRecord) =>
        isGatewayCurrent() && ownsRow(targetRunId, candidate);
      if (!isCurrent(runId, entry)) {
        attempts.delete(entry);
        // Superseded rows still belong to the sweeper's ordinary orphan cleanup.
        return false;
      }
      observe();
      const facts = [
        lifecycleGeneration,
        gatewayRuntime,
        entry.execution.status,
        entry.execution.startedAt,
        entry.execution.endedAt,
        entry.execution.lifecycleGeneration,
        entry.execution.restartRecovery,
        entry.pauseReason,
        entry.killIntent,
        entry.killReconciliation,
        entry.suppressAnnounceReason,
        entry.terminalOwner,
      ];
      const previous = attempts.get(entry);
      const unchanged = previous?.facts.every((fact, index) => fact === facts[index])
        ? previous
        : undefined;
      if (unchanged?.retained?.isCurrent()) {
        return true;
      }
      if (unchanged && unchanged.retryAt !== undefined && unchanged.retryAt > Date.now()) {
        params.schedule(unchanged.retryAt - Date.now());
        return true;
      }
      const evaluatedAttempts = attempts;
      const pending: Attempt = { facts, delayMs: 0 };
      attempts.set(entry, pending);
      const result = await params.recoverRow({
        runId,
        entry,
        gatewayRuntime,
        isCurrent,
        isGatewayCurrent,
        warn: params.warn,
      });
      if (
        attempts !== evaluatedAttempts ||
        !isGatewayCurrent() ||
        params.runs.get(runId) !== entry
      ) {
        return true;
      }
      const unchangedDuringRead = attempts.get(entry) === pending;
      attempts.delete(entry);
      if (result.status === "ignored" || result.status === "handled") {
        if (result.status === "handled" && result.retained && unchangedDuringRead) {
          const attempt = { facts, delayMs: 0, retained: result.retained };
          attempts.set(entry, attempt);
          void result.retained.released?.then(() => {
            if (attempts.get(entry) === attempt) {
              invalidate(entry);
            }
          });
        }
        return result.status === "handled";
      }
      if (result.status === "deferred") {
        const delayMs = Math.min(
          60_000,
          unchanged && unchangedDuringRead ? Math.max(1_000, unchanged.delayMs * 2) : 1_000,
        );
        attempts.set(entry, { facts, delayMs, retryAt: Date.now() + delayMs });
        params.schedule(delayMs);
        return true;
      }
      if (!isCurrent(runId, entry)) {
        return true;
      }
      const finalized = await params.finalizeRun({
        runId,
        expectedEntry: entry,
        isRecoveryCurrent: () => isCurrent(runId, entry) && result.isRecoveryCurrent?.() !== false,
        isChildSessionEffectsCurrent: result.isChildSessionEffectsCurrent,
        error: result.error,
        endedAt: result.endedAt,
        suppressSessionEffects: result.suppressSessionEffects,
      });
      if (!isCurrent(runId, entry)) {
        return true;
      }
      if (!finalized) {
        params.schedule(1_000);
      }
      return true;
    },
  };
}
