// Sweeper archival for completed collector groups (split from the sweeper for its line
// budget): a group archives only as a whole, after every member's session, attachments
// and context-engine cleanup succeed, and stops for this pass once any member changes.
import { safeRemoveAttachmentsDir } from "./subagent-registry-helpers.js";
import { getRecordedSubagentChildAuthority } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import {
  mutateCleanup,
  sweptContext,
  isCollectorArchiveReady,
  isCleanupCurrent,
  type FrozenSessionIdentity,
} from "./subagent-registry-sweep-cleanup.js";
import type {
  ContextEngineSubagentEndedParams,
  SubagentRunRecord,
} from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";
import {
  shouldSuppressSubagentSessionCleanup,
  shouldSuppressSubagentSessionEffects,
} from "./subagent-session-effects-policy.js";

export type CollectorArchiveCandidate = {
  requesterSessionKey: string;
  groupId: string;
  requesterAgentId?: string;
};

export async function sweepCollectorArchiveGroups(
  candidates: Iterable<CollectorArchiveCandidate>,
  runs: Map<string, SubagentRunRecord>,
  now: number,
  cleanupIdentities: Map<object, FrozenSessionIdentity | undefined>,
  params: {
    getRunsForCollectorGroup: (
      requesterSessionKey: string,
      groupId: string,
      requesterAgentId?: string,
    ) => Iterable<[string, SubagentRunRecord]>;
    /** The sweeper's swept-session delete, bound to its read scope. */
    deleteSession: (
      entry: SubagentRunRecord,
      identity: FrozenSessionIdentity,
    ) => Promise<"deleted" | "changed">;
    runContextEngineSubagentEnded: (params: ContextEngineSubagentEndedParams) => Promise<void>;
    clearPendingLifecycleError: (runId: string) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
    /** A Gateway restart drain leaves the remaining groups for the next Gateway. */
    drainSignal: AbortSignal;
  },
): Promise<"drained" | "swept"> {
  collectorGroups: for (const { requesterSessionKey, groupId, requesterAgentId } of candidates) {
    const readGroup = () => [
      ...params.getRunsForCollectorGroup(requesterSessionKey, groupId, requesterAgentId),
    ];
    const groupEntries = readGroup();
    if (
      groupEntries.some(
        ([, candidate]) =>
          getRecordedSubagentChildAuthority(candidate).status === "mismatch" ||
          !isCollectorArchiveReady(candidate, now) ||
          !cleanupIdentities.has(getSubagentRunRuntimeKey(candidate)) ||
          (!shouldSuppressSubagentSessionCleanup(candidate) &&
            !cleanupIdentities.get(getSubagentRunRuntimeKey(candidate))) ||
          !isCleanupCurrent(candidate, candidate),
      )
    ) {
      continue;
    }
    // A group archives only as a whole: once any member is replaced or the
    // membership changes, stop before the next phase instead of finishing it.
    const isGroupCurrent = () => {
      const liveGroup = readGroup();
      return (
        liveGroup.length === groupEntries.length &&
        groupEntries.every(([runId, expected]) => {
          const row = runs.get(runId);
          return (
            isCleanupCurrent(row, expected) &&
            isCollectorArchiveReady(row, now) &&
            liveGroup.some(([liveRunId]) => liveRunId === runId)
          );
        })
      );
    };
    for (const [candidateRunId, candidate] of groupEntries) {
      if (params.drainSignal.aborted) {
        return "drained";
      }
      let current = runs.get(candidateRunId);
      if (!isGroupCurrent() || !isCleanupCurrent(current, candidate)) {
        continue collectorGroups;
      }
      if (!shouldSuppressSubagentSessionCleanup(current)) {
        const sessionIdentity = cleanupIdentities.get(getSubagentRunRuntimeKey(candidate));
        try {
          const changed =
            !sessionIdentity ||
            (await params.deleteSession(current, sessionIdentity)) === "changed";
          if (changed) {
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
          params.warn("sessions.delete failed during collector group sweep; keeping group", {
            runId: candidateRunId,
            childSessionKey: candidate.childSessionKey,
            groupId,
            error,
          });
          continue collectorGroups;
        }
      }
      if (!isGroupCurrent()) {
        continue collectorGroups;
      }
      if (!(await safeRemoveAttachmentsDir(current))) {
        params.warn("attachment cleanup failed during collector group sweep; keeping group", {
          runId: candidateRunId,
          childSessionKey: candidate.childSessionKey,
          groupId,
        });
        continue collectorGroups;
      }
      if (
        current.cleanup !== "delete" &&
        !shouldSuppressSubagentSessionEffects(current) &&
        typeof current.contextEngineCleanupCompletedAt !== "number"
      ) {
        try {
          await params.runContextEngineSubagentEnded(sweptContext(current));
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
          params.warn("context-engine cleanup failed during collector group sweep; keeping group", {
            runId: candidateRunId,
            childSessionKey: candidate.childSessionKey,
            groupId,
            error,
          });
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
              !liveGroup.some(([liveRunId]) => liveRunId === runId)
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
      { runs },
    );
    if (deleted) {
      for (const [runId] of groupEntries) {
        params.clearPendingLifecycleError(runId);
      }
    }
  }
  return "swept";
}
