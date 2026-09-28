import type * as MediaActivity from "./media-generation-activity.js";
import type { MediaGenerationOperation } from "./media-generation-activity.js";

/** Observe native media lifecycle writes while retaining its real agent/generation fences. */
export function observeMediaActivity(
  actual: typeof MediaActivity,
  observations: {
    createOperation: (
      operation: MediaGenerationOperation,
    ) => Partial<MediaGenerationOperation> | null | undefined;
    recordProgress: (update: object) => unknown;
    completeOperation: (update: object) => unknown;
    failOperation: (update: object) => unknown;
    listOperations?: (
      ...args: Parameters<typeof MediaActivity.listMediaGenerationOperations>
    ) => MediaGenerationOperation[] | undefined;
  },
) {
  return {
    ...actual,
    listMediaGenerationOperations(
      ...args: Parameters<typeof actual.listMediaGenerationOperations>
    ) {
      return (
        observations.listOperations?.(...args) ?? actual.listMediaGenerationOperations(...args)
      );
    },
    createMediaGenerationOperation(operation: MediaGenerationOperation) {
      const configured = observations.createOperation(operation);
      if (configured === null) {
        throw new Error("Media admission refused by fixture");
      }
      return actual.createMediaGenerationOperation({
        ...operation,
        ...(configured?.taskId ? { taskId: configured.taskId } : {}),
      });
    },
    updateMediaGenerationOperation(
      runId: string,
      update: Parameters<typeof actual.updateMediaGenerationOperation>[1],
    ) {
      const operation = actual.findMediaGenerationOperation(runId);
      if (!operation || operation.endedAt !== undefined) {
        return;
      }
      const observation = { runId, ...update };
      if (update.status === "succeeded") {
        observations.completeOperation(observation);
      } else if (update.status === "failed") {
        observations.failOperation(observation);
      } else {
        observations.recordProgress(observation);
      }
      actual.updateMediaGenerationOperation(runId, update);
    },
  };
}
