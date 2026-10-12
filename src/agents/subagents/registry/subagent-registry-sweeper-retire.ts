import { removeInternalSessionEffectsSession } from "../../internal-session-effects.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import {
  safeRemoveAttachmentsDir,
  shouldRemoveSubagentAttachments,
} from "./subagent-registry-helpers.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  compareSubagentRunGeneration,
  isSameSubagentRun,
  isSameSubagentRunOwner,
} from "./subagent-run-generation.js";

export async function retireSupersededSubagentRun(params: {
  runId: string;
  entry: SubagentRunRecord;
  runs: Map<string, SubagentRunRecord>;
  clearPendingLifecycleError: (runId: string) => void;
  isCurrent?: (current: SubagentRunRecord) => boolean;
  assertCurrent?: () => void;
}): Promise<void> {
  const transcriptTarget = params.entry.execution.transcriptTarget;
  const canRetire = (current: SubagentRunRecord | undefined) =>
    current !== undefined &&
    isSameSubagentRunOwner(current, params.entry) &&
    current.attachmentId === params.entry.attachmentId &&
    current.cleanup === params.entry.cleanup &&
    current.retainAttachmentsOnKeep === params.entry.retainAttachmentsOnKeep &&
    current.execution.transcriptTarget?.agentId === transcriptTarget?.agentId &&
    current.execution.transcriptTarget?.sessionId === transcriptTarget?.sessionId &&
    current.execution.transcriptTarget?.sessionKey === transcriptTarget?.sessionKey &&
    current.execution.transcriptTarget?.storePath === transcriptTarget?.storePath &&
    current.execution.transcriptTarget?.threadId === transcriptTarget?.threadId &&
    current.execution.transcriptTarget?.expectedLifecycleRevision ===
      transcriptTarget?.expectedLifecycleRevision &&
    current.execution.transcriptTarget?.expectedWriterRunId ===
      transcriptTarget?.expectedWriterRunId &&
    params.isCurrent?.(current) !== false;
  const admitted = params.runs.get(params.runId);
  // Supersession survives retirement of the successor while external cleanup awaits.
  const superseded =
    admitted &&
    (admitted.killReconciliation?.supersededAt !== undefined ||
      [...params.runs.values()].some(
        (candidate) =>
          candidate.childSessionKey === admitted.childSessionKey &&
          compareSubagentRunGeneration(candidate, admitted) > 0,
      ));
  const isCurrent = () => canRetire(params.runs.get(params.runId));
  if (!superseded || !isCurrent()) {
    return;
  }
  const transcriptStillOwned = Array.from(params.runs.values()).some((candidate) => {
    if (isSameSubagentRun(candidate, params.entry)) {
      return false;
    }
    const candidateTarget = candidate.execution.transcriptTarget;
    return (
      candidateTarget?.sessionId === transcriptTarget?.sessionId &&
      candidateTarget?.sessionKey === transcriptTarget?.sessionKey &&
      candidateTarget?.storePath === transcriptTarget?.storePath
    );
  });
  const cleanupEntry = params.runs.get(params.runId);
  if (
    cleanupEntry &&
    transcriptTarget &&
    !transcriptStillOwned &&
    !shouldSuppressSubagentRecoverySessionEffects(cleanupEntry)
  ) {
    await removeInternalSessionEffectsSession(transcriptTarget);
    if (!isCurrent()) {
      return;
    }
  }
  if (shouldRemoveSubagentAttachments(params.entry)) {
    await safeRemoveAttachmentsDir(params.entry, isCurrent);
  }
  if (!isCurrent()) {
    return;
  }
  const deleted = await mutateSubagentRuns(
    [params.runId],
    (rows) => {
      const current = rows.get(params.runId);
      if (!canRetire(current)) {
        return { value: false };
      }
      return { value: true, postimages: new Map([[params.runId, null]]) };
    },
    { runs: params.runs, assertCurrent: params.assertCurrent },
  );
  if (deleted) {
    params.clearPendingLifecycleError(params.runId);
  }
}
