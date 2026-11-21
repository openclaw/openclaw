import type { PluginStateOperationHandler } from "openclaw/plugin-sdk/plugin-state-runtime";

export type RecallPruneOperations = {
  prune: { input: { keys: string[] }; output: void };
};

export const pruneRecallEntries: PluginStateOperationHandler<RecallPruneOperations> = (
  { input },
  transaction,
) => {
  for (const key of input.keys) {
    transaction.delete(0, key);
    transaction.delete(1, key);
  }
};
