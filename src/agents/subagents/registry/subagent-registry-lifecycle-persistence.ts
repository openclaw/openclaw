import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { SubagentLifecycleCommonContext } from "./subagent-registry-lifecycle-context.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  captureSubagentRunMutationSnapshot,
  publishSubagentRunPostimages,
  SubagentRegistryWriteError,
} from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Keep cleanup's speculative fields private until its original writer acknowledges them. */
export async function commitSubagentLifecycleMutation(
  context: SubagentLifecycleCommonContext,
  args: {
    entry: SubagentRunRecord;
    stateContext: OpenClawStateWorkerContext;
    assertCurrent: () => void;
    mutate: () => void;
    retire?: boolean;
    previous?: SubagentRunRecord;
    onPublished?: () => void;
  },
): Promise<void> {
  const assertCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(args.stateContext);
    args.assertCurrent();
    if (context.options.runs.get(args.entry.runId) !== args.entry) {
      throw new Error("Subagent cleanup lost its original registry row.");
    }
  };
  if (!args.previous) {
    assertCurrent();
  }
  const previous = args.previous ?? captureSubagentRunMutationSnapshot(args.entry);
  args.mutate();
  const published = await publishSubagentRunPostimages({
    runs: context.options.runs,
    previous: new Map([[args.entry, previous]]),
    retire: args.retire ? new Set([args.entry]) : undefined,
    persist: context.options.persistAsyncOrThrow,
    context: args.stateContext,
    assertCurrent,
    onPublished: args.onPublished,
  });
  if (published.publication === "superseded") {
    throw new SubagentRegistryWriteError(
      "committed",
      new Error("Subagent cleanup changed before publication."),
      "superseded",
    );
  }
}
