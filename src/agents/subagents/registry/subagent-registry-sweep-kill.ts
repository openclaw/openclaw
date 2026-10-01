import { getRuntimeConfig } from "../../../config/config.js";
import { isSessionDeliveryGenerationRevokedError } from "../../../config/sessions/session-delivery-generation.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import {
  isSessionLifecycleMutationActive,
  runExclusiveSessionLifecycleMutation,
} from "../../../sessions/session-lifecycle-admission.js";
import { resolveSubagentChildSessionOwner } from "./subagent-child-session-owner.js";
import {
  prepareSubagentKillSession,
  type SubagentKillSession,
} from "./subagent-control-session.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { PROVISIONAL_KILL_RECONCILIATION_MS } from "./subagent-registry-helpers.js";
import { getLatestSubagentRunByChildSessionKeyFromRuns } from "./subagent-registry-queries.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";
import {
  resolveSubagentRunDeadlineMs,
  resolveSubagentRunEffectiveEndedAt,
} from "./subagent-run-timeout.js";
import { resolveSubagentSessionCompletion } from "./subagent-session-reconciliation.js";

function hasSameRecordedChildOwner(left: SubagentRunRecord, right: SubagentRunRecord): boolean {
  const selected = left.childAgentId;
  const target = right.childAgentId;
  // Unbound legacy rows retain their historical supersession behavior.
  return !selected || !target || selected === target;
}

function findNextSubagentRunCreatedAt(
  candidates: Iterable<SubagentRunRecord>,
  entry: SubagentRunRecord,
): number | undefined {
  let nextCreatedAt = entry.killReconciliation?.supersededAt;
  for (const candidate of candidates) {
    if (
      candidate.runId === entry.runId ||
      candidate.childSessionKey !== entry.childSessionKey ||
      !hasSameRecordedChildOwner(entry, candidate) ||
      compareSubagentRunGeneration(candidate, entry) <= 0
    ) {
      continue;
    }
    nextCreatedAt = Math.min(nextCreatedAt ?? candidate.createdAt, candidate.createdAt);
  }
  return nextCreatedAt;
}

export async function reconcileDurableSubagentKillIntent(params: {
  runId: string;
  entry: SubagentRunRecord;
  runs: Map<string, SubagentRunRecord>;
  getRunsForChildSession: (childSessionKey: string) => Iterable<SubagentRunRecord>;
  loadKillRuntime: () => Promise<typeof import("./subagent-control.runtime.js")>;
  completeSubagentRunWithRecovery: (
    completion: SubagentCompletionRequest,
    source: string,
  ) => Promise<void>;
  retireSupersededRun: (runId: string, entry: SubagentRunRecord) => Promise<void>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<boolean> {
  const killIntent = params.entry.killIntent;
  if (!killIntent) {
    return false;
  }
  if (params.runs.get(params.runId) !== params.entry) {
    return false;
  }
  const childRuns = () =>
    [...params.getRunsForChildSession(params.entry.childSessionKey)].filter((candidate) =>
      hasSameRecordedChildOwner(params.entry, candidate),
    );
  const latest = getLatestSubagentRunByChildSessionKeyFromRuns(
    childRuns(),
    params.entry.childSessionKey,
  );
  if (latest !== params.entry) {
    try {
      if (
        params.runs.get(params.runId) !== params.entry ||
        getLatestSubagentRunByChildSessionKeyFromRuns(childRuns(), params.entry.childSessionKey) ===
          params.entry
      ) {
        return false;
      }
      await params.retireSupersededRun(params.runId, params.entry);
      return true;
    } catch (error) {
      params.warn("failed to retire superseded durable kill intent", {
        error,
        runId: params.runId,
        childSessionKey: params.entry.childSessionKey,
      });
      return false;
    }
  }
  const ownsCurrentGeneration = () =>
    params.runs.get(params.runId) === params.entry &&
    params.entry.killIntent === killIntent &&
    killIntent.lifecycleGeneration !== undefined &&
    isAgentEventLifecycleGenerationCurrent(killIntent.lifecycleGeneration) &&
    getLatestSubagentRunByChildSessionKeyFromRuns(childRuns(), params.entry.childSessionKey) ===
      params.entry;
  const cfg = getRuntimeConfig();
  const { agentId, storePath } = resolveSubagentChildSessionOwner(params.entry, cfg);
  let session: SubagentKillSession | undefined;
  const ownsSessionIncarnation = () => {
    try {
      session?.assertCurrent();
    } catch (error) {
      if (isSessionDeliveryGenerationRevokedError(error)) {
        return false;
      }
      throw error;
    }
    const current = session?.entry;
    return (
      current?.sessionId === killIntent.sessionId &&
      current?.lifecycleRevision === killIntent.sessionLifecycleRevision
    );
  };
  const completeKill = async (retired: boolean) => {
    await params.completeSubagentRunWithRecovery(
      {
        runId: params.runId,
        expectedEntry: params.entry,
        endedAt: killIntent.requestedAt,
        outcome: { status: "error", error: killIntent.reason },
        reason: SUBAGENT_ENDED_REASON_KILLED,
        sendFarewell: true,
        accountId: params.entry.requesterOrigin?.accountId,
        triggerCleanup: true,
        ...(retired ? { suppressSessionEffects: true } : {}),
      },
      retired ? "sweeper-retired-kill-intent" : "sweeper-pending-kill-intent",
    );
    return true;
  };
  if (
    killIntent.lifecycleGeneration === undefined ||
    !isAgentEventLifecycleGenerationCurrent(killIntent.lifecycleGeneration)
  ) {
    return await completeKill(true);
  }
  const identities = [params.entry.childSessionKey, killIntent.sessionId];
  // A live mutation owns this cancellation; reconcile other rows without waiting behind it.
  if (isSessionLifecycleMutationActive(storePath, identities)) {
    return false;
  }
  try {
    const runtime = await params.loadKillRuntime();
    if (!ownsCurrentGeneration() || isSessionLifecycleMutationActive(storePath, identities)) {
      return false;
    }
    session = await prepareSubagentKillSession(
      cfg,
      params.entry.childSessionKey,
      () => {
        if (!ownsCurrentGeneration()) {
          throw new Error("Subagent session preparation lost its original kill intent.");
        }
      },
      undefined,
      params.entry.childAgentId,
    );
    if (isSessionLifecycleMutationActive(session.storePath, identities)) {
      return false;
    }
    if (!ownsSessionIncarnation()) {
      return await completeKill(true);
    }
    return await runExclusiveSessionLifecycleMutation({
      scope: session.storePath,
      identities,
      run: async () => {
        if (!ownsCurrentGeneration()) {
          return false;
        }
        if (!ownsSessionIncarnation()) {
          return await completeKill(true);
        }
        const hasLiveRunContext = Boolean(getAgentRunContext(params.runId));
        const active = killIntent.sessionId
          ? runtime.isEmbeddedAgentRunActive(killIntent.sessionId)
          : false;
        const aborted =
          killIntent.sessionId && active
            ? runtime.abortEmbeddedAgentRun(killIntent.sessionId)
            : false;
        if (!ownsSessionIncarnation()) {
          return await completeKill(true);
        }
        runtime.clearSessionLifecycleQueues({
          keys: [params.entry.childSessionKey, killIntent.sessionId],
          agentId,
          sessionKey: params.entry.childSessionKey,
          sessionId: killIntent.sessionId,
          assertCurrent: () => {
            if (!ownsCurrentGeneration() || !ownsSessionIncarnation()) {
              throw new Error("Subagent queue cleanup lost its original kill intent.");
            }
          },
        });
        if ((active || hasLiveRunContext) && !aborted) {
          return false;
        }
        if (!ownsCurrentGeneration()) {
          return false;
        }
        if (!ownsSessionIncarnation()) {
          return await completeKill(true);
        }
        return await completeKill(false);
      },
    });
  } catch (error) {
    params.warn("failed to finish durable subagent kill intent", {
      error,
      runId: params.runId,
      childSessionKey: params.entry.childSessionKey,
    });
    return false;
  } finally {
    await session?.release();
  }
}

export async function reconcileProvisionalSubagentKill(params: {
  runId: string;
  entry: SubagentRunRecord;
  now: number;
  runs: Map<string, SubagentRunRecord>;
  completeSubagentRunWithRecovery: (
    completion: SubagentCompletionRequest,
    source: string,
  ) => Promise<void>;
  retireSupersededRun: (runId: string, entry: SubagentRunRecord) => Promise<void>;
  startSubagentAnnounceCleanupFlow: (runId: string, entry: SubagentRunRecord) => boolean;
  getRunsForChildSession: (childSessionKey: string) => Iterable<SubagentRunRecord>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<boolean> {
  const { entry, now, runId, runs } = params;
  const killReconciliation = entry.killReconciliation;
  if (!killReconciliation) {
    return false;
  }
  // The child-session index stays current across awaits. Re-read it at each
  // decision boundary so a newly registered generation can supersede this run.
  const findNextRunCreatedAt = () =>
    findNextSubagentRunCreatedAt(params.getRunsForChildSession(entry.childSessionKey), entry);
  const hasStableTaskCancellation = killReconciliation.taskCancellationAccepted === true;
  const killedAt = killReconciliation.killedAt;
  const isCurrentKill = () =>
    runs.get(runId) === entry &&
    entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
    entry.killReconciliation === killReconciliation;
  if (killedAt + PROVISIONAL_KILL_RECONCILIATION_MS > now) {
    return false;
  }
  const completion = await resolveSubagentSessionCompletion({
    childSessionKey: entry.childSessionKey,
    childAgentId: entry.childAgentId,
    fallbackEndedAt: now,
    notBeforeMs: entry.execution.startedAt ?? entry.createdAt,
    assertCurrent: () => {
      if (!isCurrentKill()) {
        throw new Error("Subagent completion read lost its provisional kill owner.");
      }
    },
  });
  if (!isCurrentKill()) {
    return false;
  }
  const nextRunCreatedAt = findNextRunCreatedAt();
  const completionEndedAt = completion
    ? resolveSubagentRunEffectiveEndedAt(entry, completion.endedAt, completion.startedAt)
    : undefined;
  const completionDeadline = completion
    ? resolveSubagentRunDeadlineMs(entry, completion.startedAt)
    : undefined;
  const killedSnapshotExpiredDeadline =
    completion?.reason === SUBAGENT_ENDED_REASON_KILLED &&
    completionDeadline !== undefined &&
    completion.endedAt > completionDeadline
      ? completionDeadline
      : undefined;
  const completionCanOverrideCancellation =
    !hasStableTaskCancellation || (completionEndedAt ?? Number.POSITIVE_INFINITY) < killedAt;
  const completionBelongsToGeneration =
    nextRunCreatedAt === undefined || (completion != null && completion.endedAt < nextRunCreatedAt);
  if (
    completion &&
    completionEndedAt !== undefined &&
    completionCanOverrideCancellation &&
    completionBelongsToGeneration &&
    (completion.reason !== SUBAGENT_ENDED_REASON_KILLED ||
      killedSnapshotExpiredDeadline !== undefined)
  ) {
    const hasNewerGeneration = nextRunCreatedAt !== undefined;
    await params.completeSubagentRunWithRecovery(
      {
        runId,
        startedAt: completion.startedAt,
        endedAt: killedSnapshotExpiredDeadline ?? completion.endedAt,
        outcome:
          killedSnapshotExpiredDeadline !== undefined ? { status: "timeout" } : completion.outcome,
        reason:
          killedSnapshotExpiredDeadline !== undefined
            ? SUBAGENT_ENDED_REASON_COMPLETE
            : completion.reason,
        sendFarewell: true,
        accountId: entry.requesterOrigin?.accountId,
        triggerCleanup: !hasNewerGeneration,
        suppressSessionEffects: hasNewerGeneration,
      },
      "sweeper-provisional-kill-completion",
    );
    if (
      hasNewerGeneration &&
      runs.get(runId) === entry &&
      entry.endedReason !== SUBAGENT_ENDED_REASON_KILLED
    ) {
      await params.retireSupersededRun(runId, entry);
      return true;
    }
    if (!isCurrentKill()) {
      return false;
    }
    if (
      entry.killReconciliation?.taskCancellationAccepted !== true ||
      completionEndedAt < killedAt
    ) {
      return false;
    }
  }
  if (!isCurrentKill()) {
    return false;
  }

  if (findNextRunCreatedAt() !== undefined) {
    await params.retireSupersededRun(runId, entry);
    return true;
  }
  entry.suppressCompletionDelivery =
    killReconciliation.suppressTaskDelivery === true || hasStableTaskCancellation
      ? true
      : undefined;
  entry.suppressAnnounceReason = undefined;
  entry.killReconciliation = undefined;
  entry.cleanupHandled = false;
  entry.cleanupCompletedAt = undefined;
  return !params.startSubagentAnnounceCleanupFlow(runId, entry);
}
