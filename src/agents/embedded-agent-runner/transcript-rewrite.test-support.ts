import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "../../config/sessions/session-transcript-reconcile.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";

export function useTranscriptRewriteTempDirs(
  registerCleanup: (cleanup: () => Promise<void>) => unknown,
) {
  const lifetime = createFixtureLifetime();
  const tempDirs = useAutoCleanupTempDirTracker((removeDirectories) => {
    registerCleanup(async () => {
      void lifetime.verifyCleanup(async () => {
        const failures: unknown[] = [];
        for (const directory of tempDirs.dirs) {
          for (const settle of [
            () => waitForSessionTranscriptIndexReconcilesInStateDir(directory),
            () => closeOpenClawAgentDatabasesAsync(directory),
          ]) {
            try {
              await settle();
            } catch (error) {
              failures.push(error);
            }
          }
        }
        if (failures.length) {
          throw new AggregateError(failures, "Transcript rewrite fixture cleanup failed");
        }
        removeDirectories();
      });
      await lifetime.cleanup();
    });
  });
  return tempDirs;
}
