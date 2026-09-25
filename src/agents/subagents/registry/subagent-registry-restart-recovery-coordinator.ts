import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
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
  const ownsRow = (runId: string, entry: SubagentRunRecord) =>
    params.runs.get(runId) === entry &&
    getLatestSubagentRunByChildSessionKeyFromRuns(
      params.getRunsForChildSession(entry.childSessionKey),
      entry.childSessionKey,
    ) === entry;

  return {
    async recover(runId: string, entry: SubagentRunRecord): Promise<boolean> {
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const gatewayRuntime = params.getGatewayRuntime();
      const isGatewayCurrent = () =>
        isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) &&
        params.getGatewayRuntime() === gatewayRuntime;
      const isCurrent = (targetRunId: string, candidate: SubagentRunRecord) =>
        isGatewayCurrent() && ownsRow(targetRunId, candidate);
      const result = await params.recoverRow({
        runId,
        entry,
        gatewayRuntime,
        isCurrent,
        isGatewayCurrent,
        warn: params.warn,
      });
      if (!isGatewayCurrent() || params.runs.get(runId) !== entry) {
        return true;
      }
      if (result.status === "ignored" || result.status === "handled") {
        return result.status === "handled";
      }
      if (result.status === "deferred") {
        params.schedule(1_000);
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
