import type { InternalSessionEntry as SessionEntry } from "../config/sessions/main-session-recovery.types.js";
import {
  buildMainSessionRecoveryClearPatch,
  type MainRecoveryStateFields,
} from "./main-session-recovery-clear.js";

const MAIN_RESTART_RECOVERY_WEDGED_FALLBACK_REASON =
  "main-session restart recovery is tombstoned for this session";

type MainRecoveryLifecycleEvent = {
  runId?: string;
  lifecycleGeneration?: string;
  data?: { error?: unknown; phase?: unknown; stopReason?: unknown };
};

export function inspectMainSessionRecoveryHealth(entry: SessionEntry):
  | { status: "none" }
  | { status: "active" }
  | {
      status: "tombstoned";
      reason: string;
      repair: "clear_stale_abort" | null;
    } {
  const state = entry.mainRestartRecovery;
  if (!state) {
    return { status: "none" };
  }
  if (!state.tombstone) {
    return { status: "active" };
  }
  return {
    status: "tombstoned",
    reason: state.tombstone.reason.trim() || MAIN_RESTART_RECOVERY_WEDGED_FALLBACK_REASON,
    repair: entry.abortedLastRun === true ? "clear_stale_abort" : null,
  };
}

function lifecyclePhase(event: MainRecoveryLifecycleEvent): "start" | "end" | "error" | null {
  const phase = event.data?.phase;
  return phase === "start" || phase === "end" || phase === "error" ? phase : null;
}

export function isMainSessionRecoveryLifecycleEvent(params: {
  entry?: Partial<Pick<SessionEntry, "restartRecoveryRuns">> | null;
  event: MainRecoveryLifecycleEvent;
}): boolean {
  const runId = params.event.runId?.trim();
  const lifecycleGeneration = params.event.lifecycleGeneration?.trim();
  const phase = lifecyclePhase(params.event);
  const interrupted = params.event.data?.stopReason === "restart";
  const matchesFence = Boolean(
    runId &&
    lifecycleGeneration &&
    params.entry?.restartRecoveryRuns?.some(
      (run) => run.runId === runId && run.lifecycleGeneration === lifecycleGeneration,
    ),
  );
  return (
    matchesFence && (phase === "start" || ((phase === "end" || phase === "error") && interrupted))
  );
}

export function projectMainSessionRecoveryLifecycle(params: {
  entry?: Partial<MainRecoveryStateFields> | null;
  event: MainRecoveryLifecycleEvent;
  snapshotPatch: Partial<SessionEntry>;
}): { action: "suppress" } | { action: "apply"; patch: Partial<SessionEntry> } {
  if (params.entry?.mainRestartRecovery?.tombstone) {
    // Exhaustion is committed only after current owners are absent. Any later
    // lifecycle event is stale and must not erase the durable operator boundary.
    return { action: "suppress" };
  }
  if (isMainSessionRecoveryLifecycleEvent(params)) {
    return { action: "suppress" };
  }
  const phase = lifecyclePhase(params.event);
  const settlesRecovery =
    (phase === "end" || phase === "error") && params.event.data?.stopReason !== "restart";
  const patch = { ...params.snapshotPatch };
  if (settlesRecovery) {
    Object.assign(patch, buildMainSessionRecoveryClearPatch(params.entry));
  }
  const runId = params.event.runId?.trim();
  const lifecycleGeneration = params.event.lifecycleGeneration?.trim();
  const runs = params.entry?.restartRecoveryRuns;
  if (
    phase === "start" ||
    !runId ||
    !lifecycleGeneration ||
    !runs?.some((run) => run.runId === runId && run.lifecycleGeneration === lifecycleGeneration)
  ) {
    return { action: "apply", patch };
  }
  const remaining = runs.filter(
    (run) => run.runId !== runId || run.lifecycleGeneration !== lifecycleGeneration,
  );
  if (params.entry?.abortedLastRun === true && remaining.length > 0) {
    return { action: "apply", patch: { restartRecoveryRuns: remaining } };
  }
  if (!settlesRecovery) {
    patch.restartRecoveryRuns = remaining.length > 0 ? remaining : undefined;
  }
  return { action: "apply", patch };
}
