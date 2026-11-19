// Queued-launch helper split from the launch manager for its line budget: the
// queued -> running start-transition plan.
import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import {
  SubagentRegistryMutationRejectedError,
  waitForPendingSubagentKillClaim,
} from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  bindSubagentRunRuntimeKey,
  getSubagentRunRuntimeKey,
  isSameSubagentRunOwner,
} from "./subagent-run-generation.js";

/** Plans the queued -> running start transition, which also disarms a dispatched launch marker. */
export function planQueuedSubagentRunStart(
  rows: ReadonlyMap<string, SubagentRunRecord>,
  selected: SubagentRunRecord,
  nextRunId: string,
  acceptedLifecycleGeneration: string,
  admission: Parameters<typeof waitForPendingSubagentKillClaim>[1],
) {
  const current = rows.get(selected.runId);
  if (
    !current ||
    !isSameSubagentRunOwner(current, selected) ||
    !isAgentEventLifecycleGenerationCurrent(acceptedLifecycleGeneration)
  ) {
    return { value: undefined };
  }
  const lifecycleStarted =
    current.execution.status === "running" &&
    typeof current.execution.startedAt === "number" &&
    current.swarmLaunchPending === true;
  const terminalBeforeAcceptance =
    current.collectorCompletion !== undefined && current.swarmLaunchPending === true;
  if (
    current.killIntent ||
    current.killReconciliation ||
    waitForPendingSubagentKillClaim(current, admission) ||
    (current.swarmLaunchPending === true &&
      typeof current.execution.endedAt === "number" &&
      current.collectorCompletion === undefined) ||
    (!terminalBeforeAcceptance && current.execution.status !== "queued" && !lifecycleStarted)
  ) {
    return { value: undefined };
  }
  if (nextRunId !== current.runId && rows.get(nextRunId)) {
    throw new SubagentRegistryMutationRejectedError(
      `collector gateway run id already exists: ${nextRunId}`,
    );
  }
  const entry = { ...current };
  entry.swarmRunId ??= current.runId;
  entry.schedulerSlotId ??= entry.swarmRunId;
  entry.runId = nextRunId;
  if (!terminalBeforeAcceptance) {
    const startedAt =
      current.execution.status === "running" ? current.execution.startedAt : undefined;
    entry.execution = {
      ...entry.execution,
      status: "running",
      acceptedAt: Date.now(),
      lifecycleGeneration: acceptedLifecycleGeneration,
      suppressSessionEffects: undefined,
      startedAt,
    };
    entry.sessionStartedAt =
      typeof startedAt === "number" ? (entry.sessionStartedAt ?? startedAt) : undefined;
  }
  entry.swarmLaunchPending = false;
  // The start transition proves the dispatched launch started: disarm in the same write.
  delete entry.launchDispatch;
  bindSubagentRunRuntimeKey(entry, getSubagentRunRuntimeKey(current));
  const postimages = new Map<string, SubagentRunRecord | null>([[nextRunId, entry]]);
  if (selected.runId !== nextRunId) {
    postimages.set(selected.runId, null);
  }
  return {
    value: { source: current, entry, terminalBeforeAcceptance },
    postimages,
    removalReason: "run_rekeyed",
    ...(current.runId !== nextRunId ? { rekeys: new Map([[current.runId, nextRunId]]) } : {}),
  };
}
