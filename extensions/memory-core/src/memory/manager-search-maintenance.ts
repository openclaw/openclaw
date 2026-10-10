// Memory Core owns detached search-time index maintenance lifecycle.
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { MemoryIndexRevisionConflictError } from "./manager-db-kernel.js";
import type { MemoryReindexRetryState } from "./manager-sync-base.js";
import { MEMORY_SYNC_DEFERRED, type MemorySyncOutcome } from "./manager-sync-outcome.js";

type MemorySearchMaintenanceManager = {
  adoptReindexRetryState(generation: MemoryReindexRetryState): void;
  takeReindexRetryStateForMaintenance(): MemoryReindexRetryState;
  sync(params: { reason: string; force?: boolean }): Promise<void>;
  status(): { dirty?: boolean; lastSyncError?: string };
  close(): Promise<void>;
};

export async function runMemorySearchMaintenance(params: {
  reason: string;
  takeDirtyGeneration: () => MemoryReindexRetryState;
  restoreDirtyGeneration: (generation: MemoryReindexRetryState) => void;
  acquireManager: () => Promise<MemorySearchMaintenanceManager | null>;
}): Promise<MemorySyncOutcome> {
  const dirtyGeneration = params.takeDirtyGeneration();
  let manager: MemorySearchMaintenanceManager | null;
  try {
    manager = await params.acquireManager();
  } catch (err) {
    params.restoreDirtyGeneration(dirtyGeneration);
    throw toErrorObject(err, "Memory search maintenance manager acquisition failed");
  }
  if (!manager) {
    params.restoreDirtyGeneration(dirtyGeneration);
    return undefined;
  }

  let maintenanceError: Error | undefined;
  let incompleteReason: MemorySyncOutcome;
  try {
    // The transient manager owns exactly this handed-off generation, merged with
    // its initial repair state. Full-retry flags still select rebuilds in runSync.
    manager.adoptReindexRetryState(dirtyGeneration);
    try {
      await manager.sync({ reason: params.reason });
    } catch (err) {
      if (!(err instanceof MemoryIndexRevisionConflictError)) {
        throw err;
      }
      // Retry only this automatic generation. The failed sync released its reindex
      // lease, and the next shadow build starts from the newest live revision.
      await manager.sync({ reason: params.reason, force: true });
    }
    const status = manager.status();
    if (status.dirty === true) {
      // Return remaining work, including edits skipped by a completed full rebuild.
      const remaining = manager.takeReindexRetryStateForMaintenance();
      params.restoreDirtyGeneration(remaining);
      incompleteReason =
        status.lastSyncError ??
        (remaining.memoryFullRetryDirty || remaining.sessionsFullRetryDirty
          ? MEMORY_SYNC_DEFERRED
          : undefined);
    }
  } catch (err) {
    params.restoreDirtyGeneration(dirtyGeneration);
    maintenanceError = toErrorObject(err, "Memory search maintenance failed");
  }
  try {
    await manager.close();
  } catch (err) {
    maintenanceError ??= toErrorObject(err, "Memory search maintenance close failed");
  }
  if (maintenanceError) {
    throw maintenanceError;
  }
  return incompleteReason;
}
