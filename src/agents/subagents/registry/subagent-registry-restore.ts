import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-persistence.js";
import { restoreSubagentRunMetadata } from "./subagent-registry-restore-metadata.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Hydration preserves task history; a restarted process never reconstructs child execution. */
export function createSubagentRegistryRestorer(config: {
  runs: Map<string, SubagentRunRecord>;
  ensureListener: () => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}) {
  let restored = false;
  let restoreInFlight: Promise<void> | undefined;

  function restoreOnce(
    throwOnError = false,
    context = captureOpenClawStateWorkerContext(),
  ): Promise<void> {
    if (restored) {
      return Promise.resolve();
    }
    if (!restoreInFlight) {
      const assertCurrent = () => assertSubagentRegistryWriteSourceCurrent(context);
      const operation = Promise.resolve().then(async () => {
        await restoreSubagentRunsFromDisk({
          runs: config.runs,
          mergeOnly: true,
          context,
          assertCurrent,
        });
        assertCurrent();
        await restoreSubagentRunMetadata(config.runs, context, assertCurrent);
        assertCurrent();
        restored = true;
      });
      restoreInFlight = operation;
      void operation.then(
        () => {
          restoreInFlight = undefined;
        },
        (error: unknown) => {
          restoreInFlight = undefined;
          config.warn("failed to restore subagent history", { error });
        },
      );
    }
    return throwOnError ? restoreInFlight : restoreInFlight.catch(() => {});
  }

  return {
    restoreOnce,
    activate(): Promise<void> {
      config.ensureListener();
      return restoreOnce(true);
    },
    reset() {
      restored = false;
    },
  };
}
