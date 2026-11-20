/** Runs the subagent announce flow with the registry row's continuation delivery fields. */
import { loadSubagentAnnounceModule } from "./subagent-registry-deps.js";
import type { SubagentLifecycleOptions } from "./subagent-registry-lifecycle-context.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";

export const runRegistrySubagentAnnounceFlow: SubagentLifecycleOptions["runSubagentAnnounceFlow"] =
  async (params) => {
    const entry =
      subagentRuns.get(params.childRunId) ??
      [...subagentRuns.values()].find(
        (candidate) => candidate.childSessionKey === params.childSessionKey,
      );
    return (await loadSubagentAnnounceModule()).runSubagentAnnounceFlow({
      ...params,
      silentAnnounce: entry?.silentAnnounce,
      wakeOnReturn: entry?.wakeOnReturn,
      continuationTargetSessionKey: entry?.continuationTargetSessionKey,
      continuationTargetSessionKeys: entry?.continuationTargetSessionKeys,
      continuationFanoutMode: entry?.continuationFanoutMode,
      continuationRecipientAuthorityBinding: entry?.continuationRecipientAuthorityBinding,
      persistContinuationRecipientAuthorityBinding: async (binding) => {
        if (!entry || !isSameSubagentRunOwner(subagentRuns.get(entry.runId), entry)) {
          return false;
        }
        // Persistence owns completion-time selection. Rows are frozen, so the binding is
        // written as a postimage through the registry writer; a failed write throws and
        // leaves the live row pending, so a retry cannot enqueue from memory-only authority.
        const committed = await mutateSubagentRuns([entry.runId], (rows) => {
          const current = rows.get(entry.runId);
          if (!current || !isSameSubagentRunOwner(current, entry)) {
            return { value: false };
          }
          return {
            value: true,
            postimages: new Map([
              [entry.runId, { ...current, continuationRecipientAuthorityBinding: binding }],
            ]),
          };
        });
        return committed && isSameSubagentRunOwner(subagentRuns.get(entry.runId), entry);
      },
      ...(entry?.continuationLineageMissing ? { continuationLineageMissing: true } : {}),
      ...(entry?.traceparent ? { traceparent: entry.traceparent } : {}),
    });
  };
