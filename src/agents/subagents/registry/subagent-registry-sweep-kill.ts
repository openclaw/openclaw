import { getRuntimeConfig } from "../../../config/config.js";
import { isSessionDeliveryGenerationRevokedError } from "../../../config/sessions/session-delivery-generation.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import {
  matchingEntries,
  selectedOperations,
  inputMatchesSessionId,
} from "../../../sessions/session-controller.lifecycle-projections.js";
import {
  SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
  isSessionMutationActive,
  runSessionMutation,
  captureSessionTarget,
  waitForSessionControllerSettlement,
} from "../../../sessions/session-controller.lifecycle.js";
import {
  cancelCapturedSessionControllerSource,
  captureSessionControllerStop,
} from "../../../sessions/session-controller.stop.js";
import {
  matchesSubagentChildSessionOwner,
  resolveSubagentChildAuthority,
} from "./subagent-child-owner-match.js";
import { resolveSubagentChildSessionOwner } from "./subagent-child-session-owner.js";
import { matchesSubagentKillIntent } from "./subagent-control-kill-intent.js";
import {
  prepareSubagentKillSession,
  type SubagentKillSession,
} from "./subagent-control-session.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { getLatestSubagentRunForChild } from "./subagent-registry-queries.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import { compareSubagentRunGeneration, isSameSubagentRunOwner } from "./subagent-run-generation.js";
import {
  resolveSubagentRunDeadlineMs,
  resolveSubagentRunEffectiveEndedAt,
} from "./subagent-run-timeout.js";
import { resolveSubagentSessionCompletion } from "./subagent-session-reconciliation.js";

function findNextSubagentRunCreatedAt(
  candidates: Iterable<SubagentRunRecord>,
  entry: SubagentRunRecord,
): number | undefined {
  let nextCreatedAt = entry.killReconciliation?.supersededAt;
  for (const candidate of candidates) {
    if (
      candidate.runId === entry.runId ||
      !matchesSubagentChildSessionOwner(candidate, entry.childSessionKey, entry.childAgentId) ||
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
  getRunsForChildSession: (
    childSessionKey: string,
    childAgentId?: string,
  ) => Iterable<SubagentRunRecord>;
  completeSubagentRunWithRecovery: (
    completion: SubagentCompletionRequest,
    source: string,
  ) => Promise<void>;
  retireSupersededRun: (runId: string, entry: SubagentRunRecord) => Promise<void>;
  retireObligations: (entry: SubagentRunRecord) => Promise<void>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<boolean> {
  const killIntent = params.entry.killIntent;
  const authority = resolveSubagentChildAuthority(params.entry);
  if (!killIntent || authority.status === "mismatch") {
    return false;
  }
  if (!isSameSubagentRunOwner(params.runs.get(params.runId), params.entry)) {
    return false;
  }
  const childRuns = () =>
    params.getRunsForChildSession(params.entry.childSessionKey, params.entry.childAgentId);
  const latest = getLatestSubagentRunForChild(childRuns(), params.entry);
  if (!isSameSubagentRunOwner(latest, params.entry)) {
    try {
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
    isSameSubagentRunOwner(params.runs.get(params.runId), params.entry) &&
    matchesSubagentKillIntent(params.runs.get(params.runId)?.killIntent, killIntent) &&
    killIntent.lifecycleGeneration !== undefined &&
    isAgentEventLifecycleGenerationCurrent(killIntent.lifecycleGeneration) &&
    isSameSubagentRunOwner(getLatestSubagentRunForChild(childRuns(), params.entry), params.entry);
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
    const killed = params.runs.get(params.runId);
    if (killed && isSameSubagentRunOwner(killed, params.entry)) {
      await params.retireObligations(killed);
    }
    return true;
  };
  if (authority.status === "legacy-unverified") {
    return await completeKill(true);
  }
  if (
    killIntent.lifecycleGeneration === undefined ||
    !isAgentEventLifecycleGenerationCurrent(killIntent.lifecycleGeneration)
  ) {
    return await completeKill(true);
  }
  const target = captureSessionTarget({
    storeScope: storePath,
    sessionKey: params.entry.childSessionKey,
    agentId,
    incarnation: killIntent.sessionId,
  });
  const identities = target.aliases;
  // A live mutation owns this cancellation; reconcile other rows without waiting behind it.
  if (isSessionMutationActive(storePath, identities)) {
    return false;
  }
  try {
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
      params.entry.childSessionIdentity,
    );
    if (isSessionMutationActive(session.storePath, identities)) {
      return false;
    }
    if (!ownsSessionIncarnation()) {
      return await completeKill(true);
    }
    return await runSessionMutation({
      diagnosticLabel: "subagent-kill-sweep",
      target,
      requiredSessionId: killIntent.sessionId,
      run: async () => {
        if (!ownsCurrentGeneration()) {
          return false;
        }
        if (!ownsSessionIncarnation()) {
          return await completeKill(true);
        }
        const sessionId = killIntent.sessionId;
        const capture = captureSessionControllerStop({
          inputs: killIntent.sessionId
            ? matchingEntries(target).flatMap(
                (owner) =>
                  owner.mailbox?.entries.filter((input) =>
                    inputMatchesSessionId(input, killIntent.sessionId),
                  ) ?? [],
              )
            : [],
          operations: sessionId
            ? [...selectedOperations([target])].filter((operation) =>
                operation.hasOwnedSessionId(sessionId),
              )
            : [],
        });
        const assertCurrent = () => {
          if (!ownsCurrentGeneration() || !ownsSessionIncarnation()) {
            throw new Error("Durable kill ownership changed before cancellation");
          }
        };
        const hasLiveRunContext = Boolean(getAgentRunContext(params.runId));
        const active = capture.operations.some((operation) => !operation.result);
        const stopped = cancelCapturedSessionControllerSource(capture, { assertCurrent });
        assertCurrent();
        const aborted = stopped.activeCancelled > 0;
        const queuedInputsSettled = await waitForSessionControllerSettlement(
          Promise.all(capture.queuedInputs.map((input) => input.settlement.promise)).then(
            () => undefined,
          ),
          SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
        );
        if (!queuedInputsSettled) {
          throw new Error("Durable subagent kill queued input cleanup exceeded its drain deadline");
        }
        if (!ownsSessionIncarnation()) {
          return await completeKill(true);
        }
        if ((active || hasLiveRunContext) && !aborted) {
          return false;
        }
        const settled = await waitForSessionControllerSettlement(
          capture.settled,
          SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
        );
        if (!settled) {
          throw new Error("Durable subagent kill source settlement exceeded its drain deadline");
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

type ProvisionalSubagentKillParams = {
  runId: string;
  entry: SubagentRunRecord;
  now: number;
  runs: Map<string, SubagentRunRecord>;
  completeSubagentRunWithRecovery: (
    completion: SubagentCompletionRequest,
    source: string,
  ) => Promise<void>;
  retireSupersededRun: (runId: string, entry: SubagentRunRecord) => Promise<void>;
  retireObligations: (entry: SubagentRunRecord) => Promise<void>;
  startSubagentAnnounceCleanupFlow: (entry: SubagentRunRecord) => boolean;
  getRunsForChildSession: (
    childSessionKey: string,
    childAgentId?: string,
  ) => Iterable<SubagentRunRecord>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

// Runs with a kill confirmation in flight, and whether another confirmation arrived meanwhile.
const confirmingKills = new Map<string, { requested: boolean }>();

/**
 * Confirms a provisional kill once its canonical outcome is final: after the killed run's
 * controller operation settles, or when the sweeper ages out a kill no settlement reached.
 * A canonical completion the cancellation did not supersede replaces it. Otherwise the kill
 * stands: its obligations retire, which re-evaluates a yielded cohort, and announce cleanup
 * resumes once no cohort holds it.
 *
 * One confirmation per run is in flight. Settlement, cohort release, and the sweeper can each
 * ask for the same kill; a request that arrives meanwhile is answered by the in-flight one,
 * which re-evaluates the run once more before it finishes.
 */
export async function reconcileProvisionalSubagentKill(
  params: ProvisionalSubagentKillParams,
): Promise<boolean> {
  const inFlight = confirmingKills.get(params.runId);
  if (inFlight) {
    inFlight.requested = true;
    return false;
  }
  const confirmation = { requested: false };
  confirmingKills.set(params.runId, confirmation);
  try {
    let entry = params.entry;
    for (;;) {
      let pass: { confirmed: boolean } | { error: unknown };
      try {
        pass = { confirmed: await confirmProvisionalSubagentKill({ ...params, entry }) };
      } catch (error) {
        pass = { error };
      }
      // A request that arrived meanwhile may follow a change this pass already read past,
      // such as its cohort's release, so it supersedes this pass's outcome. Re-evaluate the
      // run's current kill, if one remains.
      const current = params.runs.get(params.runId);
      if (!confirmation.requested || !current?.killReconciliation) {
        if ("error" in pass) {
          throw pass.error;
        }
        return pass.confirmed;
      }
      confirmation.requested = false;
      entry = current;
    }
  } finally {
    confirmingKills.delete(params.runId);
  }
}

// One confirmation pass over the kill `params.entry` records.
async function confirmProvisionalSubagentKill(
  params: ProvisionalSubagentKillParams,
): Promise<boolean> {
  const { entry, now, runId, runs } = params;
  const killReconciliation = entry.killReconciliation;
  const authority = resolveSubagentChildAuthority(entry);
  if (!killReconciliation || authority.status === "mismatch") {
    return false;
  }
  // The child-session index stays current across awaits. Re-read it at each
  // decision boundary so a newly registered generation can supersede this run.
  const findNextRunCreatedAt = () =>
    findNextSubagentRunCreatedAt(
      params.getRunsForChildSession(entry.childSessionKey, entry.childAgentId),
      entry,
    );
  const killedAt = killReconciliation.killedAt;
  const isCurrentKill = (current = runs.get(runId)) => {
    const reconciliation = current?.killReconciliation;
    return (
      isSameSubagentRunOwner(current, entry) &&
      current?.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
      reconciliation !== undefined &&
      reconciliation.killedAt === killedAt &&
      reconciliation.supersededAt === killReconciliation.supersededAt &&
      Boolean(reconciliation.suppressTaskDelivery) ===
        Boolean(killReconciliation.suppressTaskDelivery) &&
      // Confirmation strengthens the same cancellation while completion capture awaits.
      (killReconciliation.taskCancellationAccepted !== true ||
        reconciliation.taskCancellationAccepted === true)
    );
  };
  const completion =
    authority.status === "legacy-unverified"
      ? undefined
      : await resolveSubagentSessionCompletion({
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
    runs.get(runId)?.killReconciliation?.taskCancellationAccepted !== true ||
    (completionEndedAt ?? Number.POSITIVE_INFINITY) < killedAt;
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
      "provisional-kill-completion",
    );
    if (
      hasNewerGeneration &&
      isSameSubagentRunOwner(runs.get(runId), entry) &&
      runs.get(runId)?.endedReason !== SUBAGENT_ENDED_REASON_KILLED
    ) {
      await params.retireSupersededRun(runId, entry);
      return true;
    }
    if (
      !isCurrentKill() ||
      runs.get(runId)?.killReconciliation?.taskCancellationAccepted !== true ||
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
  // The kill stands. Retire its obligations unless its kill owner already did; retiring
  // again would abort the continuation its cohort may already be delivering. A yielded
  // cohort keeps its retired member and resolves first; its release re-enters here.
  if (runs.get(runId)?.suppressCompletionDelivery !== true) {
    await params.retireObligations(runs.get(runId)!);
  }
  if (!isCurrentKill() || runs.get(runId)?.requesterSettleWake) {
    return false;
  }
  const published = await mutateSubagentRuns(
    [runId],
    (rows) => {
      const current = rows.get(runId);
      if (
        !current ||
        !isCurrentKill(current) ||
        current.requesterSettleWake ||
        findNextRunCreatedAt() !== undefined
      ) {
        return { value: undefined };
      }
      const next: SubagentRunRecord = {
        ...current,
        // The requester hears of a confirmed kill once, through its cohort or this row's own
        // completion, unless it already knows: it stopped or reset itself, or its own turn still
        // held the row when the kill landed (a transferred row no longer names that turn).
        suppressCompletionDelivery:
          current.suppressCompletionDelivery === true ||
          current.killReconciliation?.suppressTaskDelivery === true ||
          current.requesterTurnRunId !== undefined
            ? true
            : undefined,
        suppressAnnounceReason: undefined,
        killReconciliation: undefined,
        cleanupHandled: false,
        cleanupCompletedAt: undefined,
      };
      return { value: next, postimages: new Map([[runId, next]]) };
    },
    { runs },
  );
  if (!published) {
    return false;
  }
  return !params.startSubagentAnnounceCleanupFlow(published);
}
