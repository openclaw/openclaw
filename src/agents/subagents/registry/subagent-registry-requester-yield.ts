import type { ProgressContinuationState } from "../../../channels/progress-continuation.js";
/** Settles durable child ownership when the spawning requester turn ends. */
import type { AcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import { promoteFollowupYield } from "../completion/session-followup-completion.js";
import {
  captureRequesterCronAuthority,
  promoteRequesterCronAuthority,
} from "../requester-cron-authority.js";
import { promoteRequesterFinalAttachment } from "../requester-final-attachment.js";
import { ANNOUNCE_COMPLETION_HARD_EXPIRY_MS } from "./subagent-registry-helpers.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-pause.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  compareSubagentRunGeneration,
  recordLatestSubagentRun,
} from "./subagent-run-generation.js";
import { hasSubagentRunEnded, isRetainedUnendedSubagentRun } from "./subagent-run-liveness.js";
import { getSubagentSessionStartedAt } from "./subagent-session-metrics.js";

/** A requester child whose completion is still owed to the requester session. */
export type UnsettledRequesterChild = {
  runId: string;
  childSessionKey: string;
  label?: string;
  startedAt?: number;
  /**
   * Running children have not ended; completing children ended and still owe
   * delivery; paused children yielded for an incoming continuation and will
   * not complete until one arrives.
   */
  state: "running" | "completing" | "paused";
  /** True when an earlier requester yield already armed a settle wake for this child. */
  wakeArmed: boolean;
};

/**
 * Lists this requester session's announcing children whose completion has not
 * reached the requester yet, regardless of which requester turn spawned them.
 * Children still bound to `excludeRequesterTurnRunId` belong to that turn's own
 * claim and are omitted.
 */
export function listUnsettledRequesterChildrenInRuns(params: {
  requesterSessionKey: string;
  requesterAgentId?: string;
  excludeRequesterTurnRunId?: string;
  runs: Map<string, SubagentRunRecord>;
  now?: number;
}): UnsettledRequesterChild[] {
  const requesterSessionKey = params.requesterSessionKey.trim();
  if (!requesterSessionKey) {
    return [];
  }
  const excludedTurnRunId = params.excludeRequesterTurnRunId?.trim() || undefined;
  // Select each child session's latest generation before judging eligibility,
  // so a superseded generation cannot stand in for a killed or collected successor.
  const latestByChildSessionKey = new Map<string, SubagentRunRecord>();
  for (const entry of params.runs.values()) {
    if (
      entry.requesterSessionKey === requesterSessionKey &&
      (!params.requesterAgentId || entry.requesterAgentId === params.requesterAgentId)
    ) {
      recordLatestSubagentRun(latestByChildSessionKey, entry.childSessionKey, entry);
    }
  }
  const now = params.now ?? Date.now();
  const children: UnsettledRequesterChild[] = [];
  for (const entry of latestByChildSessionKey.values()) {
    if (
      entry.collect === true ||
      entry.expectsCompletionMessage !== true ||
      (excludedTurnRunId !== undefined && entry.requesterTurnRunId === excludedTurnRunId) ||
      entry.killIntent ||
      entry.killReconciliation ||
      entry.suppressCompletionDelivery === true
    ) {
      continue;
    }
    const wake = entry.requesterSettleWake;
    const wakeArmed = wake?.status === "pending" || wake?.status === "dispatching";
    let state: UnsettledRequesterChild["state"];
    if (!hasSubagentRunEnded(entry)) {
      if (!isRetainedUnendedSubagentRun(entry, now)) {
        continue;
      }
      state = "running";
    } else if (entry.pauseReason === "sessions_yield") {
      // markSubagentRunPausedAfterYield records a pause as an ended execution
      // without an outcome; the child resumes only through a continuation.
      state = "paused";
    } else if (
      wakeArmed ||
      entry.delivery?.status === "pending" ||
      entry.delivery?.status === "in_progress"
    ) {
      state = "completing";
    } else {
      continue;
    }
    const startedAt = getSubagentSessionStartedAt(entry);
    children.push({
      runId: entry.runId,
      childSessionKey: entry.childSessionKey,
      ...(entry.label ? { label: entry.label } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      state,
      wakeArmed,
    });
  }
  return children.toSorted((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

/** Persists explicit yield intent before the requester run is aborted. */
export function markRequesterTurnYieldedInRuns(params: {
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterTurnRunId: string;
  runs: Map<string, SubagentRunRecord>;
  persistOrThrow(...runIds: string[]): void;
}): number {
  const requesterSessionKey = params.requesterSessionKey.trim();
  const requesterTurnRunId = params.requesterTurnRunId.trim();
  if (!requesterSessionKey || !requesterTurnRunId) {
    return 0;
  }
  const entries = [...params.runs.values()].filter(
    (entry) =>
      entry.requesterSessionKey === requesterSessionKey &&
      (!params.requesterAgentId || entry.requesterAgentId === params.requesterAgentId) &&
      entry.requesterTurnRunId === requesterTurnRunId &&
      entry.expectsCompletionMessage === true,
  );
  if (entries.every((entry) => entry.requesterTurnYielded === true)) {
    return entries.length;
  }
  const cronAuthority = captureRequesterCronAuthority({
    requesterSessionKey,
    requesterAgentId: params.requesterAgentId,
    requesterTurnRunId,
    batch: entries,
    runs: params.runs,
  });
  const previous = entries.map((entry) => entry.requesterTurnYielded);
  for (const entry of entries) {
    entry.requesterTurnYielded = true;
  }
  try {
    params.persistOrThrow(...entries.map((entry) => entry.runId));
  } catch (error) {
    cronAuthority?.revoke();
    entries.forEach((entry, index) => {
      entry.requesterTurnYielded = previous[index];
    });
    throw error;
  }
  cronAuthority?.commit();
  return entries.length;
}

export function settleRequesterTurnAfterSessionSpawns(params: {
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterTurnRunId: string;
  requesterYielded: boolean;
  acceptedSessionSpawns: readonly AcceptedSessionSpawn[];
  progressPresentation?: ProgressContinuationState;
  runs: Map<string, SubagentRunRecord>;
  persistOrThrow(...runIds: string[]): void;
  schedule(runId: string, entry: SubagentRunRecord, kind: "completion" | "settle"): void;
}): boolean {
  const requesterSessionKey = params.requesterSessionKey.trim();
  const requesterTurnRunId = params.requesterTurnRunId.trim();
  const spawnsByRunId = new Map(
    params.acceptedSessionSpawns.map((spawn) => [spawn.runId, spawn] as const),
  );
  if (!requesterSessionKey || !requesterTurnRunId || spawnsByRunId.size === 0) {
    return false;
  }

  // Completion rows keep their original task owner across steer; inline or
  // non-completion spawns are intentionally outside this batch.
  const entries = [...params.runs.values()].filter(
    (entry) =>
      entry.requesterSessionKey === requesterSessionKey &&
      (!params.requesterAgentId || entry.requesterAgentId === params.requesterAgentId) &&
      entry.requesterTurnRunId === requesterTurnRunId &&
      entry.expectsCompletionMessage === true,
  );
  const requiredRunIds = new Set(
    params.acceptedSessionSpawns
      .filter((spawn) => spawn.expectsCompletionMessage === true)
      .map((spawn) => spawn.runId),
  );
  for (const entry of entries) {
    const taskRunId = entry.taskRunId ?? entry.runId;
    const spawn = spawnsByRunId.get(taskRunId);
    if (
      !spawn ||
      entry.childSessionKey !== spawn.childSessionKey ||
      (params.requesterYielded && entry.requesterTurnYielded !== true)
    ) {
      return false;
    }
    requiredRunIds.delete(taskRunId);
  }
  // Accepted completion receipts outlive registry rows. A surviving subset
  // cannot attest that the whole requester obligation transferred to a wake.
  if (requiredRunIds.size > 0) {
    return false;
  }

  const firstEntry = entries[0];
  if (!firstEntry) {
    return false;
  }
  const requester = params.runs.get(requesterTurnRunId);
  const requesterSnapshot =
    params.requesterYielded &&
    requester?.childSessionKey === requesterSessionKey &&
    requester.execution.status === "running" &&
    !requester.killIntent &&
    !requester.killReconciliation &&
    ![...params.runs.values()].some(
      (entry) =>
        entry.childSessionKey === requesterSessionKey &&
        compareSubagentRunGeneration(entry, requester) > 0,
    )
      ? structuredClone(requester)
      : undefined;
  const batchRunIds = entries.map((entry) => entry.runId).toSorted();
  const previousStates = entries.map((entry) => ({
    delivery: structuredClone(entry.delivery),
    requesterSettleWake: structuredClone(entry.requesterSettleWake),
    requesterTurnRunId: entry.requesterTurnRunId,
    requesterTurnYielded: entry.requesterTurnYielded,
    retireAfterRequesterTurn: entry.retireAfterRequesterTurn,
  }));
  const requesterAlreadyDeliveredFinal =
    params.requesterYielded &&
    entries.every(
      (entry) =>
        entry.execution.status === "terminal" &&
        typeof entry.execution.endedAt === "number" &&
        entry.delivery?.status === "delivered" &&
        typeof entry.cleanupCompletedAt === "number",
    ) &&
    entries.some((entry) => {
      const receipt = entry.delivery?.requesterVisibleFinal;
      return (
        receipt?.requesterTurnRunId === requesterTurnRunId &&
        receipt.batchRunIds.length === batchRunIds.length &&
        receipt.batchRunIds.every((runId, index) => runId === batchRunIds[index])
      );
    });
  let rearmGeneration: number | undefined;
  if (params.requesterYielded && !requesterAlreadyDeliveredFinal) {
    rearmGeneration =
      Math.max(0, ...entries.map((entry) => entry.requesterSettleWake?.rearmGeneration ?? 0)) + 1;
    const progressOperationId = params.progressPresentation?.operationId;
    for (const entry of entries) {
      const existing = entry.requesterSettleWake;
      const completionEnded = typeof entry.execution.endedAt === "number";
      // An in-progress delivery may already target the requester run being aborted.
      // Re-arm it like a delivered result so that completion cannot die with that turn.
      if (completionEnded && entry.delivery?.status !== "delivered") {
        // The persisted yielded batch now owns terminal delivery. Mark the old
        // per-child attempt terminal so it cannot keep the batch unsettled.
        entry.delivery = {
          ...(entry.delivery ?? { status: "pending" }),
          disposition: "intentional_non_delivery",
        };
      }
      entry.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        batchRunIds,
        requesterYieldBatch: true,
        ...(completionEnded ? { afterRequesterYield: true } : {}),
        rearmGeneration,
        progressOperationId,
        ...(existing?.retireAfterSettle === true || entry.retireAfterRequesterTurn === true
          ? { retireAfterSettle: true }
          : {}),
      };
      entry.requesterTurnRunId = undefined;
      entry.requesterTurnYielded = undefined;
      entry.retireAfterRequesterTurn = undefined;
    }
  } else {
    for (const entry of entries) {
      if (entry.delivery) {
        delete entry.delivery.requesterVisibleFinal;
      }
      if (requesterAlreadyDeliveredFinal) {
        // The receipt proves this yielded batch already reached requester-visible delivery.
        // Clear its provisional wake so settling the parent cannot replay the batch.
        entry.requesterSettleWake = undefined;
      }
      entry.requesterTurnRunId = undefined;
      entry.requesterTurnYielded = undefined;
      if (
        entry.completionTarget === "parent" &&
        typeof entry.execution.endedAt === "number" &&
        entry.delivery?.status === "pending"
      ) {
        // Private delivery becomes eligible only when its spawning turn releases it.
        entry.delivery.windowStartedAt ??= Date.now();
        entry.delivery.deadlineAt ??=
          entry.delivery.windowStartedAt + ANNOUNCE_COMPLETION_HARD_EXPIRY_MS;
      }
      if (entry.retireAfterRequesterTurn === true) {
        if (entry.requesterSettleWake) {
          entry.requesterSettleWake.retireAfterSettle = true;
          entry.retireAfterRequesterTurn = undefined;
        } else {
          params.runs.delete(entry.runId);
        }
      }
    }
  }
  // A finished child can dispatch its wake before the requester's lifecycle-end
  // event. Publish the paused task owner in the same commit as that wake batch.
  const requesterPaused =
    requester && requesterSnapshot && markSubagentRunPausedAfterYield({ entry: requester });
  try {
    params.persistOrThrow(
      ...entries.map((entry) => entry.runId),
      ...(requesterPaused ? [requester.runId] : []),
    );
  } catch (error) {
    if (requesterPaused && requesterSnapshot) {
      for (const key of Object.keys(requester)) {
        Reflect.deleteProperty(requester, key);
      }
      Object.assign(requester, requesterSnapshot);
    }
    entries.forEach((entry, index) => {
      const previous = previousStates[index];
      params.runs.set(entry.runId, entry);
      entry.delivery = previous?.delivery;
      entry.requesterSettleWake = previous?.requesterSettleWake;
      entry.requesterTurnRunId = previous?.requesterTurnRunId;
      entry.requesterTurnYielded = previous?.requesterTurnYielded;
      entry.retireAfterRequesterTurn = previous?.retireAfterRequesterTurn;
    });
    throw error;
  }

  promoteFollowupYield({ requesterTurnRunId, entries, rearmGeneration });
  promoteRequesterCronAuthority({ requesterTurnRunId, batch: entries, rearmGeneration });
  if (rearmGeneration !== undefined && params.requesterAgentId) {
    promoteRequesterFinalAttachment({
      requesterAgentId: params.requesterAgentId,
      requesterSessionKey,
      requesterTurnRunId,
      batchRunIds,
      rearmGeneration,
    });
  }
  for (const entry of entries) {
    if (
      entry.completionTarget === "parent" &&
      typeof entry.execution.endedAt === "number" &&
      params.runs.has(entry.runId)
    ) {
      params.schedule(entry.runId, entry, "completion");
    }
  }
  if (
    rearmGeneration !== undefined &&
    entries.every((entry) => typeof entry.execution.endedAt === "number")
  ) {
    // Active children keep the frozen batch; their normal completion owner schedules it.
    params.schedule(firstEntry.runId, firstEntry, "settle");
  } else if (
    !params.requesterYielded &&
    entries.every((entry) => typeof entry.execution.endedAt === "number")
  ) {
    // A terminal child cannot wake while its requester still owns the turn.
    // Once a normal parent response settles, resume its original per-child delivery.
    for (const entry of entries) {
      if (params.runs.has(entry.runId)) {
        params.schedule(entry.runId, entry, "settle");
      }
    }
  }
  return true;
}
