import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { SubagentLifecycleCommonContext } from "./subagent-registry-lifecycle-context.js";
import { getCurrentSubagentRunOwner } from "./subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  mutateSubagentRuns,
  SubagentRegistryMutationRejectedError,
} from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { copySubagentRunRuntimeOwner, isSameSubagentRunOwner } from "./subagent-run-generation.js";

export async function commitSubagentLifecycleMutation(
  context: SubagentLifecycleCommonContext,
  args: {
    entry: SubagentRunRecord;
    stateContext: OpenClawStateWorkerContext;
    assertCurrent: (current: SubagentRunRecord) => void;
    mutate: (draft: SubagentRunRecord, current: SubagentRunRecord) => void | false;
    retire?: boolean | ((entry: SubagentRunRecord) => boolean);
    onPublished?: (entry: SubagentRunRecord) => void;
  },
): Promise<SubagentRunRecord> {
  const admittedEntry = getCurrentSubagentRunOwner(context.options.runs, args.entry);
  if (!admittedEntry) {
    throw new SubagentRegistryMutationRejectedError("Subagent cleanup execution changed.");
  }
  const runId = admittedEntry.runId;
  const assertCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(args.stateContext);
    const current = getCurrentSubagentRunOwner(context.options.runs, args.entry);
    if (!current) {
      throw new SubagentRegistryMutationRejectedError("Subagent cleanup execution changed.");
    }
    if (current.runId !== runId) {
      throw new SubagentRegistryMutationRejectedError(
        "Subagent cleanup address changed before persistence.",
      );
    }
    args.assertCurrent(current);
  };
  let publishedEntry: SubagentRunRecord | undefined;
  const plannedEntry = await mutateSubagentRuns(
    [runId],
    (rows) => {
      const current = rows.get(runId);
      if (!current || !isSameSubagentRunOwner(current, args.entry)) {
        throw new SubagentRegistryMutationRejectedError("Subagent cleanup execution changed.");
      }
      args.assertCurrent(current);
      const draft = copySubagentRunRuntimeOwner(current, structuredClone(current));
      if (args.mutate(draft, current) === false) {
        return { value: current };
      }
      return {
        value: draft,
        postimages: new Map([
          [
            draft.runId,
            (typeof args.retire === "function" ? args.retire(draft) : args.retire) ? null : draft,
          ],
        ]),
      };
    },
    {
      runs: context.options.runs,
      context: args.stateContext,
      assertCurrent,
      onPublished: (postimages, entry) => {
        publishedEntry = postimages.get(entry.runId) ?? entry;
        args.onPublished?.(publishedEntry);
      },
    },
  );
  // Runtime Gateway custody belongs to this ACK's published row, not the private draft.
  return publishedEntry ?? plannedEntry;
}
