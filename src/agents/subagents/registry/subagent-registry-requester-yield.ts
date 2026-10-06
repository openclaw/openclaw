import { isDeepStrictEqual } from "node:util";
import type { ProgressContinuationState } from "../../../channels/progress-continuation.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { AcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import { promoteFollowupYield } from "../completion/session-followup-completion.js";
import {
  promoteRequesterCronAuthority,
  type PreparedRequesterCronAuthority,
} from "../requester-cron-authority.js";
import { promoteRequesterFinalAttachment } from "../requester-final-attachment.js";
import { ANNOUNCE_COMPLETION_HARD_EXPIRY_MS } from "./subagent-registry-helpers.js";
import {
  mutateSubagentRuns,
  SubagentRegistryMutationRejectedError,
  SubagentRegistryWriteError,
} from "./subagent-registry-persistence.js";
import { getLatestSubagentRunByChildSessionKeyFromRuns } from "./subagent-registry-queries.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-pause.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  isRequesterCompletionCohortCurrent,
  isRequesterYieldCohortMember,
  isRequesterSettleWakeForRun,
} from "./subagent-requester-settle-identity.js";
import {
  compareSubagentRunGeneration,
  isSameSubagentRunOwner,
  recordLatestSubagentRun,
} from "./subagent-run-generation.js";
import { hasSubagentRunEnded, isRetainedUnendedSubagentRun } from "./subagent-run-liveness.js";
import { getSubagentSessionStartedAt } from "./subagent-session-metrics.js";

/** Accepted steering keeps the child's execution and transfers only its requester-turn claim. */
export async function adoptSubagentRunForRequesterTurnInRuns(params: {
  expected: SubagentRunRecord;
  requesterSessionKey: string;
  requesterAgentId: string;
  requesterTurnRunId: string;
  assertCurrent: () => void;
  runs: Map<string, SubagentRunRecord>;
}): Promise<AcceptedSessionSpawn | undefined> {
  const requesterTurnRunId = params.requesterTurnRunId.trim();
  return mutateSubagentRuns(
    [params.expected.runId],
    (rows) => {
      const entry = rows.get(params.expected.runId);
      if (
        !entry ||
        !(
          requesterTurnRunId.length > 0 &&
          isSameSubagentRunOwner(entry, params.expected) &&
          entry.requesterSessionKey === params.requesterSessionKey &&
          entry.requesterAgentId === params.requesterAgentId &&
          (!entry.requesterTurnRunId || entry.requesterTurnRunId === requesterTurnRunId) &&
          entry.expectsCompletionMessage === true &&
          entry.collect !== true &&
          !entry.killIntent &&
          !entry.killReconciliation &&
          entry.suppressCompletionDelivery !== true &&
          entry.cleanupCompletedAt === undefined &&
          entry.requesterSettleWake?.status !== "dispatching" &&
          (entry.requesterSettleWake?.batchRunIds === undefined
            ? entry.requesterSettleWake?.requesterYieldBatch !== true
            : entry.requesterSettleWake.batchRunIds.length === 1 &&
              entry.requesterSettleWake.batchRunIds[0] === entry.runId) &&
          (entry.requesterSettleWake?.requesterYieldBatch !== true ||
            (entry.requesterSettleWake.status === "pending" &&
              entry.requesterSettleWake.attemptCount === 0 &&
              entry.requesterSettleWake.rearmGeneration !== undefined)) &&
          (entry.delivery?.status === "pending" || entry.delivery?.status === "failed") &&
          entry.delivery.disposition !== "permanent_failure" &&
          (entry.delivery.disposition !== "intentional_non_delivery" ||
            entry.requesterSettleWake !== undefined)
        )
      ) {
        return { value: undefined };
      }
      const accepted: AcceptedSessionSpawn = {
        runId: entry.taskRunId ?? entry.runId,
        childSessionKey: entry.childSessionKey,
        expectsCompletionMessage: true,
      };
      if (entry.requesterTurnRunId === requesterTurnRunId) {
        return { value: accepted };
      }
      const next = structuredClone(entry);
      next.requesterTurnRunId = requesterTurnRunId;
      next.requesterTurnYielded = undefined;
      if (next.requesterSettleWake?.requesterYieldBatch === true) {
        delete next.requesterSettleWake.requesterYieldBatch;
        delete next.requesterSettleWake.batchRunIds;
      }
      return { value: accepted, postimages: new Map([[entry.runId, next]]) };
    },
    {
      runs: params.runs,
      context: captureOpenClawStateWorkerContext(),
      assertCurrent: params.assertCurrent,
    },
  );
}

export type RequesterInitialTransfer = (params: {
  kind: "intent" | "yielded-cohort" | "completed-cohort";
  entries: readonly SubagentRunRecord[];
  prepare?: () => Promise<void>;
  assertHandoffCurrent: (entries: readonly SubagentRunRecord[]) => void;
  mutate: (entries: SubagentRunRecord[]) => ReadonlySet<string> | void;
  validateSelection?: () => void;
  finish: (entries: readonly SubagentRunRecord[]) => void;
  release?: (entries: SubagentRunRecord[]) => void;
  afterRelease?: (entries: readonly SubagentRunRecord[]) => void;
}) => Promise<void>;

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
 * claim and are omitted, as is the settle-wake cohort already reaching that turn.
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
      (excludedTurnRunId !== undefined &&
        (entry.requesterTurnRunId === excludedTurnRunId ||
          isRequesterSettleWakeForRun({
            entry,
            runId: excludedTurnRunId,
            requesterSessionKey,
            requesterAgentId: params.requesterAgentId,
            runsById: params.runs,
          }))) ||
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

/** Completion children that a requester turn still claims. */
export function selectRequesterTurnChildren(
  runs: ReadonlyMap<string, SubagentRunRecord>,
  requesterSessionKey: string,
  requesterAgentId: string | undefined,
  requesterTurnRunId: string,
  onSuperseded?: (entry: SubagentRunRecord) => void,
): SubagentRunRecord[] {
  return [...runs.values()]
    .filter(
      (entry) =>
        entry.requesterSessionKey === requesterSessionKey &&
        (!requesterAgentId || entry.requesterAgentId === requesterAgentId) &&
        entry.requesterTurnRunId === requesterTurnRunId &&
        entry.expectsCompletionMessage === true,
    )
    .filter((entry) => {
      if (
        isRequesterCompletionCohortCurrent(
          entry,
          (key, matches, childAgentId) =>
            getLatestSubagentRunByChildSessionKeyFromRuns(
              runs.values(),
              key,
              matches,
              childAgentId,
            ) ?? null,
        )
      ) {
        return true;
      }
      onSuperseded?.(entry);
      return false;
    });
}

const nextRearmGeneration = (entries: readonly SubagentRunRecord[]) =>
  Math.max(0, ...entries.map((entry) => entry.requesterSettleWake?.rearmGeneration ?? 0)) + 1;

/** Persists explicit yield intent before the requester run is aborted. */
export async function markRequesterTurnYieldedInRuns(params: {
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterTurnRunId: string;
  runs: Map<string, SubagentRunRecord>;
  transfer: RequesterInitialTransfer;
  preparedAuthority: PreparedRequesterCronAuthority | null;
}): Promise<number> {
  const requesterSessionKey = params.requesterSessionKey.trim();
  const requesterTurnRunId = params.requesterTurnRunId.trim();
  if (!requesterSessionKey || !requesterTurnRunId) {
    return 0;
  }
  const { preparedAuthority } = params;
  let cronAuthority: Awaited<ReturnType<PreparedRequesterCronAuthority["bind"]>>;
  try {
    const selectedEntries = selectRequesterTurnChildren(
      params.runs,
      requesterSessionKey,
      params.requesterAgentId,
      requesterTurnRunId,
    );
    if (selectedEntries.length === 0) {
      return 0;
    }
    await params.transfer({
      kind: "intent",
      entries: selectedEntries,
      validateSelection: () => {
        const selected = selectRequesterTurnChildren(
          params.runs,
          requesterSessionKey,
          params.requesterAgentId,
          requesterTurnRunId,
        );
        if (
          selected.length !== selectedEntries.length ||
          selected.some(
            (entry) => !selectedEntries.some((old) => isSameSubagentRunOwner(old, entry)),
          )
        ) {
          throw new SubagentRegistryMutationRejectedError(
            "Requester yield membership changed before admission",
          );
        }
      },
      assertHandoffCurrent: (entries) => {
        if (entries.some((entry) => entry.requesterTurnYielded !== true)) {
          throw new Error("Requester yield intent no longer owns its handoff");
        }
      },
      prepare: async () => {
        cronAuthority = await preparedAuthority?.bind({
          batch: selectedEntries,
          runs: params.runs,
        });
      },
      mutate: (entries) => {
        for (const entry of entries) {
          entry.requesterTurnYielded = true;
        }
      },
      finish: () => cronAuthority?.commit(),
    });
    if (preparedAuthority) {
      try {
        await preparedAuthority.validate();
      } catch (error) {
        throw new SubagentRegistryWriteError("committed", error, "published");
      }
    }
    return selectedEntries.length;
  } catch (error) {
    cronAuthority?.revoke();
    throw error;
  }
}

export async function settleRequesterTurnAfterSessionSpawns(params: {
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterTurnRunId: string;
  requesterYielded: boolean;
  acceptedSessionSpawns: readonly AcceptedSessionSpawn[];
  progressPresentation?: ProgressContinuationState;
  runs: Map<string, SubagentRunRecord>;
  transfer: RequesterInitialTransfer;
  schedule(runId: string, entry: SubagentRunRecord, kind: "completion" | "settle"): void;
}): Promise<boolean> {
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
  const selectedEntries = selectRequesterTurnChildren(
    params.runs,
    requesterSessionKey,
    params.requesterAgentId,
    requesterTurnRunId,
  );
  const requiredRunIds = new Set(
    params.acceptedSessionSpawns
      .filter((spawn) => spawn.expectsCompletionMessage === true)
      .map((spawn) => spawn.runId),
  );
  for (const entry of selectedEntries) {
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
  if (requiredRunIds.size > 0 || selectedEntries.length === 0) {
    return false;
  }

  const childRunIds = new Set(selectedEntries.map((entry) => entry.runId));
  const selectedBatchRunIds = [...childRunIds].toSorted();
  let batchRunIds = selectedBatchRunIds;
  let rearmGeneration: number | undefined;
  let needsCohortRelease = false;
  let yieldedFinalDeliverable = false;
  const ownsRequester = (
    requester: SubagentRunRecord | undefined,
  ): requester is SubagentRunRecord =>
    params.requesterYielded &&
    requester?.childSessionKey === requesterSessionKey &&
    !requester.killIntent &&
    !requester.killReconciliation &&
    ![...params.runs.values()].some(
      (entry) =>
        entry.childSessionKey === requesterSessionKey &&
        compareSubagentRunGeneration(entry, requester) > 0,
    );
  const selectedRequester = params.runs.get(requesterTurnRunId);
  const selectedMembers =
    ownsRequester(selectedRequester) && !childRunIds.has(selectedRequester.runId)
      ? [...selectedEntries, selectedRequester]
      : selectedEntries;
  const children = (candidates: readonly SubagentRunRecord[]) =>
    candidates.filter((entry) => childRunIds.has(entry.runId));
  const validateSelection = () => {
    const currentRequester = params.runs.get(requesterTurnRunId);
    if (
      ownsRequester(currentRequester) &&
      !selectedMembers.some((entry) => isSameSubagentRunOwner(entry, currentRequester))
    ) {
      throw new SubagentRegistryMutationRejectedError(
        "Requester pause owner appeared outside the admitted cohort",
      );
    }
    const current = selectRequesterTurnChildren(
      params.runs,
      requesterSessionKey,
      params.requesterAgentId,
      requesterTurnRunId,
    );
    if (
      current.length !== childRunIds.size ||
      current.some((entry) => !childRunIds.has(entry.runId))
    ) {
      throw new SubagentRegistryMutationRejectedError(
        "Requester cohort membership changed before admission",
      );
    }
  };
  await params.transfer({
    kind: params.requesterYielded ? "yielded-cohort" : "completed-cohort",
    entries: selectedMembers,
    validateSelection,
    assertHandoffCurrent: (members) => {
      if (!needsCohortRelease) {
        return;
      }
      if (
        children(members).some((entry) => {
          const wake = entry.requesterSettleWake;
          return (
            entry.requesterTurnRunId !== requesterTurnRunId ||
            entry.requesterTurnYielded !== true ||
            wake?.status !== "pending" ||
            wake.attemptCount !== 0 ||
            (wake.yieldedFinalDeliverable === true) !== yieldedFinalDeliverable ||
            !isRequesterYieldCohortMember(entry, batchRunIds, rearmGeneration)
          );
        })
      ) {
        throw new SubagentRegistryMutationRejectedError(
          "Requester initial cohort no longer owns its handoff",
        );
      }
    },
    mutate: (members) => {
      const entries = children(members);
      for (const entry of entries) {
        const spawn = spawnsByRunId.get(entry.taskRunId ?? entry.runId);
        if (
          !spawn ||
          entry.childSessionKey !== spawn.childSessionKey ||
          (params.requesterYielded && entry.requesterTurnYielded !== true)
        ) {
          throw new SubagentRegistryMutationRejectedError(
            "Requester spawn receipt lost its child owner",
          );
        }
      }
      const firstEntry = entries[0]!;
      const requester = members.find((entry) => entry.runId === requesterTurnRunId);
      const requesterOwnsSession = ownsRequester(requester);
      const pauseRequester =
        requesterOwnsSession && requester.execution.status === "running" ? requester : undefined;
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
      const preparedWake = firstEntry.requesterSettleWake;
      const preparedBatchRunIds = preparedWake?.batchRunIds;
      const preparedCohort =
        params.requesterYielded &&
        !requesterAlreadyDeliveredFinal &&
        preparedWake?.requesterYieldBatch === true &&
        preparedWake.rearmGeneration !== undefined &&
        preparedBatchRunIds !== undefined &&
        isDeepStrictEqual(
          preparedBatchRunIds.filter((runId) => params.runs.has(runId)),
          selectedBatchRunIds,
        ) &&
        entries.every((entry) => {
          const wake = entry.requesterSettleWake;
          return (
            wake?.status === "pending" &&
            wake.attemptCount === 0 &&
            isRequesterYieldCohortMember(entry, preparedBatchRunIds, preparedWake.rearmGeneration)
          );
        });
      // Retirement removes obsolete rows, not the surviving wake's frozen identity.
      batchRunIds = preparedCohort ? preparedBatchRunIds : selectedBatchRunIds;
      rearmGeneration = preparedCohort ? preparedWake.rearmGeneration : undefined;
      needsCohortRelease = params.requesterYielded && !requesterAlreadyDeliveredFinal;
      yieldedFinalDeliverable = preparedCohort
        ? preparedWake.yieldedFinalDeliverable === true
        : needsCohortRelease;
      if (
        needsCohortRelease &&
        ((entries.some((entry) => entry.requesterSettleWake?.requesterYieldBatch === true) &&
          !preparedCohort) ||
          (preparedCohort && pauseRequester))
      ) {
        throw new SubagentRegistryWriteError(
          "committed",
          new Error("Prepared requester cohort no longer has its complete paused owner"),
          "superseded",
        );
      }
      const retired = new Set<string>();
      if (params.requesterYielded && !requesterAlreadyDeliveredFinal && !preparedCohort) {
        rearmGeneration = nextRearmGeneration(entries);
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
            ...(existing?.pauseNotice ? { pauseNotice: existing.pauseNotice } : {}),
            status: "pending",
            attemptCount: 0,
            batchRunIds,
            requesterYieldBatch: true,
            // Written only by builds that let a yielded requester answer; released
            // markerless private batches keep their admitted private policy.
            yieldedFinalDeliverable: true,
            ...(completionEnded ? { afterRequesterYield: true } : {}),
            rearmGeneration,
            progressOperationId,
            ...(existing?.retireAfterSettle === true || entry.retireAfterRequesterTurn === true
              ? { retireAfterSettle: true }
              : {}),
          };
          entry.retireAfterRequesterTurn = undefined;
        }
      } else if (!preparedCohort) {
        // Distinct tasks sharing a child retain one completion owner after the turn retires.
        const completionGeneration =
          !requesterAlreadyDeliveredFinal &&
          new Set(entries.map((entry) => entry.childSessionKey)).size < entries.length
            ? nextRearmGeneration(entries)
            : undefined;
        for (const entry of entries) {
          if (completionGeneration !== undefined) {
            const existing = entry.requesterSettleWake;
            entry.requesterSettleWake = {
              ...(existing?.pauseNotice ? { pauseNotice: existing.pauseNotice } : {}),
              ...(existing?.retireAfterSettle ? { retireAfterSettle: true } : {}),
              status: "pending",
              attemptCount: 0,
              batchRunIds,
              rearmGeneration: completionGeneration,
            };
          }
          if (entry.delivery) {
            entry.delivery = { ...entry.delivery };
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
              entry.requesterSettleWake = { ...entry.requesterSettleWake, retireAfterSettle: true };
              entry.retireAfterRequesterTurn = undefined;
            } else {
              retired.add(entry.runId);
            }
          }
        }
      }
      // A finished child can dispatch its wake before the requester's lifecycle-end
      // event. Publish the paused task owner in the same commit as that wake batch.
      if (pauseRequester) {
        pauseRequester.completion = pauseRequester.completion
          ? { ...pauseRequester.completion }
          : undefined;
        markSubagentRunPausedAfterYield({ entry: pauseRequester });
      }
      return retired;
    },
    finish: (members) => {
      const entries = children(members);
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
    },
    ...(params.requesterYielded
      ? {
          release: (members: SubagentRunRecord[]) => {
            if (!needsCohortRelease) {
              return;
            }
            for (const entry of children(members)) {
              entry.requesterTurnRunId = undefined;
              entry.requesterTurnYielded = undefined;
            }
          },
        }
      : {}),
    afterRelease: (members) => {
      const entries = children(members);
      for (const entry of entries) {
        if (entry.pauseReason === "sessions_yield" && entry.requesterSettleWake?.pauseNotice) {
          params.schedule(entry.runId, entry, "settle");
          continue;
        }
        if (
          entry.completionTarget === "parent" &&
          typeof entry.execution.endedAt === "number" &&
          params.runs.has(entry.runId)
        ) {
          params.schedule(entry.runId, entry, "completion");
        }
      }
      // Active children keep the frozen batch; their normal completion owner schedules it.
      if (!entries.every((entry) => typeof entry.execution.endedAt === "number")) {
        return;
      }
      if (rearmGeneration !== undefined) {
        params.schedule(entries[0]!.runId, entries[0]!, "settle");
      } else if (!params.requesterYielded) {
        // A terminal child cannot wake while its requester still owns the turn.
        // Once a normal parent response settles, resume its original per-child delivery.
        for (const entry of entries) {
          if (params.runs.has(entry.runId)) {
            params.schedule(entry.runId, entry, "settle");
          }
        }
      }
    },
  });
  return true;
}
