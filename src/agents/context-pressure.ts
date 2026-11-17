import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/**
 * Sole owner of context-pressure decisions.
 *
 * Only a request that cannot fit the model window may fail a turn. Every other
 * pressure signal (reserve thresholds, measured occupancy, provider soft
 * triggers) can only schedule maintenance, and maintenance runs only at a
 * boundary where the current tool batch can continue afterwards.
 *
 * | request > window | maintenance due | boundary safe | declined this run | decision      |
 * |------------------|-----------------|---------------|-------------------|---------------|
 * | yes              | any             | any           | any               | "overflow"    |
 * | no               | yes             | yes           | no                | "maintenance" |
 * | no               | yes             | yes           | yes               | send          |
 * | no               | yes             | no            | any               | send (defer)  |
 * | no               | no              | any           | any               | send          |
 *
 * "overflow" may end in a failed turn when recovery cannot make the request
 * fit. "maintenance" compacts and then always continues the same turn,
 * whatever the compaction outcome.
 */
export type ContextPressure = "overflow" | "maintenance";

export function decideContextPressure(params: {
  estimatedPromptTokens: number;
  windowTokens: number;
  maintenanceDue: boolean;
  boundarySafe: boolean;
  runId?: string;
}): ContextPressure | undefined {
  if (exceedsContextWindow(params.estimatedPromptTokens, params.windowTokens)) {
    return "overflow";
  }
  if (!params.maintenanceDue || !params.boundarySafe) {
    return undefined;
  }
  return params.runId && isBoundaryMaintenanceDeclined(params.runId) ? undefined : "maintenance";
}

/** The only failure predicate: the priced request is larger than the window. */
export function exceedsContextWindow(
  estimatedPromptTokens: number | undefined,
  windowTokens: number | undefined,
): boolean {
  return (
    typeof estimatedPromptTokens === "number" &&
    typeof windowTokens === "number" &&
    Number.isFinite(estimatedPromptTokens) &&
    Number.isFinite(windowTokens) &&
    windowTokens > 0 &&
    estimatedPromptTokens > windowTokens
  );
}

/**
 * A request boundary is safe for maintenance when stopping here and continuing
 * from the transcript is indistinguishable from sending the request: every
 * tool call has a recorded result, no tool item is still running, no tool
 * started background work that reports into this attempt, and no approval
 * prompt is waiting for the user.
 */
export function isToolBatchBoundarySafe(evidence: {
  pendingToolCalls: number;
  itemLifecycle: { startedCount: number; completedCount: number; activeCount: number };
  asyncActivity: boolean;
  approvalPromptSent: boolean;
}): boolean {
  return (
    evidence.pendingToolCalls === 0 &&
    evidence.itemLifecycle.activeCount === 0 &&
    evidence.itemLifecycle.completedCount === evidence.itemLifecycle.startedCount &&
    !evidence.asyncActivity &&
    !evidence.approvalPromptSent
  );
}

const DECLINED_KEY = Symbol.for("openclaw.boundaryMaintenanceDeclined");
const declinedRuns = resolveGlobalSingleton(DECLINED_KEY, () => new Set<string>());

/** Maintenance that could not reduce context is not retried for the rest of the run. */
export function declineBoundaryMaintenance(runId: string): void {
  declinedRuns.add(runId);
}

export function isBoundaryMaintenanceDeclined(runId: string): boolean {
  return declinedRuns.has(runId);
}

export function clearBoundaryMaintenance(runId: string): void {
  declinedRuns.delete(runId);
}
