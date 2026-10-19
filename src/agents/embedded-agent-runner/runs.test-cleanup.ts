import { waitForSessionControllerSettlement } from "../../sessions/session-controller.lifecycle-observation.js";
import { SESSION_CONTROLLER_DRAIN_TIMEOUT_MS } from "../../sessions/session-controller.lifecycle.js";
import {
  ABANDONED_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUNS_BY_FILE,
  ACTIVE_EMBEDDED_RUN_SNAPSHOTS,
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID,
  EMBEDDED_RUN_COMPLETION_CLAIMS,
  EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS,
  nativeAttemptAttachments,
  type EmbeddedAgentQueueHandle,
  waitForEmbeddedRunOwnerSettlement,
} from "./run-state.js";

/** Cancels detached native attempts and joins every captured producer generation. */
async function drainActiveEmbeddedRuns(): Promise<void> {
  const attempts = [...nativeAttemptAttachments()].map((attachment) => ({
    handle: attachment.handle,
    attachment,
  }));
  const failures: unknown[] = [];

  // Controller Stop owns attached attempts; only detached attempts need a direct abort.
  for (const { handle, attachment } of attempts) {
    if (attachment.operation) {
      continue;
    }
    try {
      if (handle.isAbortable?.() !== false) {
        handle.abort("restart");
      }
    } catch (error) {
      failures.push(error);
    }
  }
  const settlements = attempts.map(({ attachment }) =>
    waitForEmbeddedRunOwnerSettlement(attachment).catch((error: unknown) => {
      failures.push(error);
    }),
  );
  if (
    !(await waitForSessionControllerSettlement(
      Promise.all(settlements).then(() => undefined),
      SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
    ))
  ) {
    failures.push(
      new Error(
        `Native run cleanup remains pending after ${SESSION_CONTROLLER_DRAIN_TIMEOUT_MS}ms`,
      ),
    );
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Native run cleanup failed");
  }
}

type ClearActiveEmbeddedRun = (sessionId: string, handle: EmbeddedAgentQueueHandle) => void;

/** Builds the teardown API published by the embedded-run owner in test processes. */
export function createEmbeddedRunsTestApi(clearActiveEmbeddedRun: ClearActiveEmbeddedRun) {
  return {
    drainActiveEmbeddedRuns,
    resetActiveEmbeddedRuns() {
      const attempts = [...nativeAttemptAttachments()];
      for (const { handle } of attempts) {
        EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.delete(handle);
      }
      for (const { sessionId, handle } of attempts) {
        clearActiveEmbeddedRun(sessionId, handle);
      }
      ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.clear();
      for (const claim of EMBEDDED_RUN_COMPLETION_CLAIMS.values()) {
        claim.settleRegistration(undefined);
      }
      EMBEDDED_RUN_COMPLETION_CLAIMS.clear();
      ACTIVE_EMBEDDED_RUN_SNAPSHOTS.clear();
      ACTIVE_EMBEDDED_RUNS_BY_FILE.clear();
      ABANDONED_EMBEDDED_RUNS.clear();
    },
  };
}
