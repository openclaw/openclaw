import type { MockInstance } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
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
      } else if (update.progressSummary !== undefined) {
        observations.recordProgress(observation);
      }
      actual.updateMediaGenerationOperation(runId, update);
    },
  };
}

/** Observe terminal publication; never dispatch work or supply an owner outcome. */
export function observeMediaGenerationSettlement(observations: {
  completeOperation: MockInstance;
  failOperation: MockInstance;
}) {
  const outcomes: Array<{ runId: string; status: "succeeded" | "failed" }> = [];
  let changed = createDeferred();
  for (const [mock, outcome] of [
    [observations.completeOperation, "succeeded"],
    [observations.failOperation, "failed"],
  ] as const) {
    const original = mock.getMockImplementation();
    mock.mockImplementation(
      (update: { runId?: string; handle?: { runId: string } | null }, ...rest: unknown[]) => {
        const result = original?.(update, ...rest);
        outcomes.push({ runId: update.runId ?? update.handle!.runId, status: outcome });
        changed.resolve();
        changed = createDeferred();
        return result;
      },
    );
  }
  return {
    async wait(count = 1) {
      while (outcomes.length < count) {
        await changed.promise;
      }
      const { findMediaGenerationOperation } = await import("./media-generation-activity.js");
      return outcomes.slice(0, count).map(({ runId, status }) => {
        const published = findMediaGenerationOperation(runId)?.status;
        if (published !== status) {
          throw new Error(`Media operation ${runId} did not publish ${status}`);
        }
        return published;
      });
    },
  };
}
