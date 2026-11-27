import type { callGateway } from "../../../gateway/call.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { emitSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import { assertionSucceeds } from "../../../shared/assertion.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import {
  resolveSubagentChildAgentId,
  resolveSubagentChildAuthority,
} from "./subagent-child-owner-match.js";
import { isDeliverySuspended, isSubagentRetirementSettled } from "./subagent-delivery-state.js";
import { safeRemoveAttachmentsDir } from "./subagent-registry-helpers.js";
import { getRecordedSubagentChildAuthority, subagentRuns } from "./subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  mutateSubagentRuns,
} from "./subagent-registry-persistence.js";
import { SUBAGENT_SESSION_RUN_TTL_MS } from "./subagent-registry-work-index.js";
import type {
  ContextEngineSubagentEndedParams,
  SubagentRunRecord,
} from "./subagent-registry.types.js";
import { isSubagentPausedByYield } from "./subagent-requester-turn-custody.js";
import {
  getSubagentRunRuntimeKey,
  isSameSubagentRun,
  isSameSubagentRunOwner,
} from "./subagent-run-generation.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";
import {
  shouldSuppressSubagentSessionCleanup,
  shouldSuppressSubagentSessionEffects,
} from "./subagent-session-effects-policy.js";

export function createSubagentSweepContext(
  runs: Map<string, SubagentRunRecord>,
  options: {
    callGateway: typeof callGateway;
    clearPendingLifecycleError: (runId: string) => void;
    cleanupCollectorLaunchResources: (entry: SubagentRunRecord) => Promise<boolean>;
    runContextEngineSubagentEnded: (params: ContextEngineSubagentEndedParams) => Promise<void>;
    notifyContextEngineSubagentEnded: (params: ContextEngineSubagentEndedParams) => Promise<void>;
    getRunsForCollectorGroup: (
      requesterSessionKey: string,
      groupId: string,
      requesterAgentId?: string,
    ) => Iterable<[string, SubagentRunRecord]>;
    warn: (message: string, meta?: Record<string, unknown>) => void;
    runCleanupTail: (runId: string, label: string, run: () => Promise<unknown>) => void;
  },
  now: number,
  drainSignal: AbortSignal,
) {
  let source:
    | { context: ReturnType<typeof captureOpenClawStateWorkerContext> }
    | { error: unknown };
  try {
    source = { context: captureOpenClawStateWorkerContext() };
  } catch (error) {
    source = { error };
  }
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const gatewayResolver = getGatewayContextResolver(runs);
  const retiredRead = new Error("Subagent sweep read lost its selected run");
  let readsStarted = false;
  const assertCurrent = () => {
    // Memory-only sweeps need no read admission; a later read still uses this original source.
    if (readsStarted) {
      if ("error" in source) {
        throw source.error;
      }
      assertSubagentRegistryWriteSourceCurrent(source.context);
    }
    if (
      !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) ||
      getGatewayContextResolver(runs) !== gatewayResolver
    ) {
      throw new Error("Subagent sweep read lost its Gateway owner");
    }
  };
  const isHostCurrent = () => assertionSucceeds(assertCurrent);
  const readScope = {
    gatewayResolver,
    assertCurrent,
    retiredRead,
    completionCurrent: { isHostCurrent, prepare: async () => isHostCurrent() },
    assertRunCurrent: (entry: SubagentRunRecord) => {
      assertCurrent();
      if (runs.get(entry.runId) !== entry) {
        throw retiredRead;
      }
      readsStarted = true;
      assertCurrent();
    },
  };
  async function removeSession(entry: SubagentRunRecord) {
    if (shouldSuppressSubagentSessionCleanup(entry)) {
      return "suppressed" as const;
    }
    const identity = cleanupIdentities.get(getSubagentRunRuntimeKey(entry));
    if (!identity) {
      return "pending" as const;
    }
    let failure: unknown;
    const outcome = await deleteSubagentSessionForCleanup({
      callGateway: options.callGateway,
      gatewayBinding: {
        resolveGatewayContext: getGatewayContextResolver(entry) ?? gatewayResolver,
      },
      isCurrent: () => {
        readScope.assertRunCurrent(entry);
        return isCleanupCurrent(runs.get(entry.runId), entry);
      },
      childSessionKey: entry.childSessionKey,
      childAgentId: resolveSubagentChildAgentId(entry),
      expectedSessionId: identity.sessionId,
      expectedLifecycleRevision: identity.lifecycleRevision,
      onError: (error) => {
        failure = error;
      },
    });
    if (outcome === "failed") {
      throw failure;
    }
    return outcome;
  }
  const collectorArchiveCandidates = new Map<
    string,
    { requesterSessionKey: string; groupId: string; requesterAgentId?: string }
  >();
  // Completion stays fresh across awaits, but deletion must retain the earlier
  // CAS identity. Bind it to the exact run so replacements wait for another pass.
  const cleanupIdentities = new Map<object, ReturnType<typeof freezeSessionIdentity>>();
  function prepareCleanup(entries: readonly (readonly [string, SubagentRunRecord])[]) {
    for (const [, entry] of entries) {
      if (
        !hasSettledCleanupObligations(entry) ||
        !(entry.collect && entry.collectorCompletion
          ? entry.collectorLaunchCleanupPending || isCollectorArchiveReady(entry, now)
          : entry.archiveAtMs && entry.archiveAtMs <= now && !isSessionCleanupDeferred(entry))
      ) {
        continue;
      }
      // Suppressed session cleanup still requires the captured member for artifact cleanup.
      cleanupIdentities.set(
        getSubagentRunRuntimeKey(entry),
        shouldSuppressSubagentSessionCleanup(entry) ? undefined : freezeSessionIdentity(entry),
      );
    }
  }

  async function sweepRun(runId: string, observedEntry: SubagentRunRecord) {
    let entry = observedEntry;
    if (entry.collect && entry.collectorCompletion) {
      if (entry.collectorLaunchCleanupPending) {
        let suppressSessionCleanup = false;
        try {
          const result = await removeSession(entry);
          if (result === "pending") {
            return;
          }
          suppressSessionCleanup = result === "changed" || result === "suppressed";
          if (result === "deleted") {
            if (
              !isCleanupCurrent(runs.get(runId), entry) ||
              !(await options.cleanupCollectorLaunchResources(entry)) ||
              !isCleanupCurrent(runs.get(runId), entry)
            ) {
              return;
            }
            emitSessionLifecycleEvent({
              sessionKey: entry.childSessionKey,
              reason: "delete",
              parentSessionKey: entry.swarmRequesterSessionKey ?? entry.requesterSessionKey,
            });
          } else if (result === "changed" && !isCleanupCurrent(runs.get(runId), entry)) {
            return;
          }
        } catch (error) {
          options.warn("failed to retry collector launch cleanup", {
            runId,
            childSessionKey: entry.childSessionKey,
            error,
          });
          return;
        }
        const updated = await mutateCleanup(
          runs,
          entry,
          (current) =>
            current.collect === true &&
            current.collectorCompletion !== undefined &&
            current.collectorLaunchCleanupPending === true,
          (draft) => {
            if (suppressSessionCleanup) {
              draft.execution.suppressSessionEffects = true;
            }
            draft.collectorLaunchCleanupPending = false;
            draft.cleanupCompletedAt = now;
          },
        );
        if (!updated) {
          return;
        }
        entry = updated;
      }
      const groupId = entry.groupId?.trim();
      const requesterSessionKey = entry.swarmRequesterSessionKey ?? entry.requesterSessionKey;
      if (groupId) {
        collectorArchiveCandidates.set(
          JSON.stringify([entry.requesterAgentId, requesterSessionKey, groupId]),
          { requesterSessionKey, groupId, requesterAgentId: entry.requesterAgentId },
        );
      }
      return;
    }
    if (
      isSessionCleanupDeferred(entry) ||
      (!entry.archiveAtMs && entry.cleanup === "keep" && entry.spawnMode !== "session")
    ) {
      return;
    }
    if (!entry.archiveAtMs) {
      const deleted = await mutateCleanup(
        runs,
        entry,
        (current) =>
          !current.archiveAtMs &&
          typeof current.cleanupCompletedAt === "number" &&
          now - current.cleanupCompletedAt > SUBAGENT_SESSION_RUN_TTL_MS,
        null,
      );
      if (deleted === null) {
        options.clearPendingLifecycleError(runId);
        if (!shouldSuppressSubagentSessionEffects(entry)) {
          options.runCleanupTail(runId, "context-engine cleanup", () =>
            options.notifyContextEngineSubagentEnded(sweptContext(entry)),
          );
        }
        if (!entry.retainAttachmentsOnKeep) {
          await safeRemoveAttachmentsDir(entry);
        }
      }
      return;
    }
    if (entry.archiveAtMs > now) {
      return;
    }
    let sessionOwnershipChanged: boolean;
    try {
      const result = await removeSession(entry);
      if (result === "pending") {
        return;
      }
      sessionOwnershipChanged = result === "changed";
    } catch (error) {
      options.warn("sessions.delete failed during subagent sweep; keeping run for retry", {
        runId,
        childSessionKey: entry.childSessionKey,
        error,
      });
      return;
    }
    const deleted = await mutateCleanup(
      runs,
      entry,
      (current) =>
        current.archiveAtMs !== undefined &&
        current.archiveAtMs <= now &&
        !(current.collect && current.collectorCompletion),
      null,
    );
    if (deleted !== null) {
      return;
    }
    options.clearPendingLifecycleError(runId);
    await safeRemoveAttachmentsDir(entry);
    if (!shouldSuppressSubagentSessionEffects(entry) && !sessionOwnershipChanged) {
      options.runCleanupTail(runId, "context-engine cleanup", () =>
        options.notifyContextEngineSubagentEnded(sweptContext(entry)),
      );
    }
  }

  async function sweepCollectorGroups() {
    collectorGroups: for (const {
      requesterSessionKey,
      groupId,
      requesterAgentId,
    } of collectorArchiveCandidates.values()) {
      const readGroup = () => [
        ...options.getRunsForCollectorGroup(requesterSessionKey, groupId, requesterAgentId),
      ];
      const groupEntries = readGroup();
      if (
        groupEntries.some(
          ([, candidate]) =>
            !isCollectorArchiveReady(candidate, now) ||
            !cleanupIdentities.has(getSubagentRunRuntimeKey(candidate)) ||
            (!shouldSuppressSubagentSessionCleanup(candidate) &&
              !cleanupIdentities.get(getSubagentRunRuntimeKey(candidate))) ||
            !isCleanupCurrent(candidate, candidate),
        )
      ) {
        continue;
      }
      for (const [candidateRunId, candidate] of groupEntries) {
        if (drainSignal.aborted) {
          return false;
        }
        const warnCleanup = (message: string, failure?: { error: unknown }) =>
          options.warn(message, {
            runId: candidateRunId,
            childSessionKey: candidate.childSessionKey,
            groupId,
            ...failure,
          });
        let current = runs.get(candidateRunId);
        if (!isCleanupCurrent(current, candidate) || !isCollectorArchiveReady(current, now)) {
          continue collectorGroups;
        }
        try {
          const result = await removeSession(current);
          if (result === "pending") {
            continue collectorGroups;
          }
          if (result === "changed") {
            const updated = await mutateCleanup(
              runs,
              current,
              (row) => isCollectorArchiveReady(row, now),
              (draft) => {
                draft.execution.suppressSessionEffects = true;
              },
            );
            if (!updated) {
              continue collectorGroups;
            }
            current = updated;
          }
        } catch (error) {
          warnCleanup("sessions.delete failed during collector group sweep; keeping group", {
            error,
          });
          continue collectorGroups;
        }
        if (!isCleanupCurrent(runs.get(candidateRunId), candidate)) {
          continue collectorGroups;
        }
        if (!(await safeRemoveAttachmentsDir(current))) {
          warnCleanup("attachment cleanup failed during collector group sweep; keeping group");
          continue collectorGroups;
        }
        if (
          current.cleanup !== "delete" &&
          !shouldSuppressSubagentSessionEffects(current) &&
          typeof current.contextEngineCleanupCompletedAt !== "number"
        ) {
          try {
            await options.runContextEngineSubagentEnded(sweptContext(current));
            if (
              !(await mutateCleanup(
                runs,
                current,
                (row) => isCollectorArchiveReady(row, now),
                (draft) => {
                  draft.contextEngineCleanupCompletedAt = Date.now();
                },
              ))
            ) {
              continue collectorGroups;
            }
          } catch (error) {
            warnCleanup(
              "context-engine cleanup failed during collector group sweep; keeping group",
              { error },
            );
            continue collectorGroups;
          }
        }
      }
      const deleted = await mutateSubagentRuns(
        groupEntries.map(([runId]) => runId),
        (rows) => {
          const liveGroup = readGroup();
          if (
            liveGroup.length !== groupEntries.length ||
            groupEntries.some(([runId, expected]) => {
              const current = rows.get(runId);
              return (
                !isCleanupCurrent(current, expected) ||
                !isCollectorArchiveReady(current, now) ||
                !liveGroup.some(([, member]) => isSameSubagentRun(member, expected))
              );
            })
          ) {
            return { value: false };
          }
          return {
            value: true,
            postimages: new Map(groupEntries.map(([runId]) => [runId, null])),
            removalReason: "retention",
          };
        },
        { runs, deleteOnly: true },
      );
      if (deleted) {
        for (const [runId] of groupEntries) {
          options.clearPendingLifecycleError(runId);
        }
      }
    }
    return true;
  }

  return { ...readScope, prepareCleanup, sweepRun, sweepCollectorGroups };
}

function freezeSessionIdentity(entry: SubagentRunRecord) {
  const authority = resolveSubagentChildAuthority(entry);
  return authority.status === "verified" ? authority.sessionIdentity : undefined;
}

const sweptContext = (entry: SubagentRunRecord) => ({
  childSessionKey: entry.childSessionKey,
  reason: "swept" as const,
  agentDir: entry.agentDir,
  workspaceDir: entry.workspaceDir,
});

const isSessionCleanupDeferred = (entry: SubagentRunRecord) =>
  isSubagentPausedByYield(entry) ||
  entry.delivery?.status === "in_progress" ||
  (entry.delivery?.status === "pending" &&
    (entry.delivery.disposition === "session_queued" ||
      entry.expectsCompletionMessage === true ||
      entry.delivery.payload !== undefined));

const isCollectorArchiveReady = (entry: SubagentRunRecord, now: number): boolean =>
  entry.collectorCompletion !== undefined &&
  entry.collectorLaunchCleanupPending !== true &&
  entry.archiveAtMs !== undefined &&
  entry.archiveAtMs <= now;

function hasSettledCleanupObligations(entry: SubagentRunRecord): boolean {
  return (
    getRecordedSubagentChildAuthority(entry).status !== "mismatch" &&
    typeof entry.execution.endedAt === "number" &&
    (entry.retireAfterSettle !== true || isSubagentRetirementSettled(entry)) &&
    (subagentRuns.isCompletionAuthorityRetired(entry) ||
      (!entry.killIntent && !entry.killReconciliation && !entry.requesterSettleWake)) &&
    !isDeliverySuspended(entry)
  );
}

function isCleanupCurrent(
  current: SubagentRunRecord | undefined,
  expected: SubagentRunRecord,
): current is SubagentRunRecord {
  return (
    current !== undefined &&
    hasSettledCleanupObligations(current) &&
    isSameSubagentRunOwner(current, expected) &&
    current.execution.status === expected.execution.status &&
    current.execution.endedAt === expected.execution.endedAt &&
    !isSessionCleanupDeferred(current)
  );
}

function mutateCleanup(
  runs: Map<string, SubagentRunRecord>,
  entry: SubagentRunRecord,
  ready: (current: SubagentRunRecord) => boolean,
  update: ((draft: SubagentRunRecord) => void) | null,
) {
  return mutateSubagentRuns(
    [entry.runId],
    (rows) => {
      const current = rows.get(entry.runId);
      if (!isCleanupCurrent(current, entry) || !ready(current)) {
        return { value: undefined };
      }
      // Cleanup changes only top-level bookkeeping and the frozen execution record.
      const next = update ? { ...current, execution: { ...current.execution } } : null;
      if (update && next) {
        update(next);
      }
      return {
        value: next,
        postimages: new Map([[entry.runId, next]]),
        removalReason: "retention",
      };
    },
    { runs, deleteOnly: update === null },
  );
}
