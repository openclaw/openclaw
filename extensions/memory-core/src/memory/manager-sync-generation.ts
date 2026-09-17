import { resolveUserPath } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { withSqliteWorkerThreadReservation } from "openclaw/plugin-sdk/sqlite-runtime";
import { memoryCpuProcessEntrypoints } from "./manager-cpu-entrypoints.js";
import type { MemoryIndexDatabase } from "./manager-database-context.js";
import { waitForMemoryReindexLock } from "./manager-reindex-lock.js";

/** Keep the maintenance lease through native publication close and thread drainage. */
export async function runMemorySyncGeneration({
  databasePath,
  publishedDatabase,
  begin,
  run,
  end,
}: {
  databasePath: string;
  publishedDatabase: MemoryIndexDatabase;
  begin: () => void;
  run: () => Promise<void>;
  end: () => void;
}): Promise<void> {
  // Reset must not overtake embeddings awaiting their final incremental writes.
  // All sync generations own the existing maintenance lease through cleanup.
  const dbPath = resolveUserPath(databasePath);
  const lock = await waitForMemoryReindexLock(dbPath, { waitForActive: true });
  try {
    // A previous failed close still owns native/lease cleanup. Finish it
    // before opening a new generation instead of reusing a revoked owner.
    await publishedDatabase.closePublicationWorker();
    begin();
    try {
      // Keep one native publication connection for this generation, then
      // release its broker capacity even when the manager stays cached.
      await withSqliteWorkerThreadReservation(
        resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.publication),
        () =>
          run().then(
            () => publishedDatabase.closePublicationWorker(),
            async (error: unknown) => {
              const [cleanup] = await Promise.allSettled([
                publishedDatabase.closePublicationWorker(),
              ]);
              if (cleanup.status === "rejected") {
                throw new AggregateError(
                  [error, cleanup.reason],
                  `${String(error)}; Memory sync cleanup failed: ${String(cleanup.reason)}`,
                  { cause: error },
                );
              }
              throw error;
            },
          ),
      );
    } finally {
      end();
    }
  } finally {
    await lock.release();
  }
}
