// Memory Core plugin module implements manager session reindex behavior.
<<<<<<< HEAD
import type { MemorySyncParams } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
export function shouldSyncSessionsForReindex(params: {
  hasSessionSource: boolean;
  sessionsDirty: boolean;
  sessionsFullRetryDirty?: boolean;
  dirtySessionFileCount: number;
<<<<<<< HEAD
  sync?: MemorySyncParams;
=======
  sync?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
  };
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  needsFullReindex?: boolean;
}): boolean {
  if (!params.hasSessionSource) {
    return false;
  }
<<<<<<< HEAD
  if (params.sync?.sessions?.some((session) => session.sessionId.trim().length > 0)) {
    return true;
  }
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  if (params.sync?.sessionFiles?.some((sessionFile) => sessionFile.trim().length > 0)) {
    return true;
  }
  if (params.sync?.force) {
    return true;
  }
  if (params.needsFullReindex) {
    return true;
  }
  if (params.sessionsFullRetryDirty) {
    return true;
  }
  const reason = params.sync?.reason;
  if (reason === "session-start" || reason === "watch") {
    return false;
  }
  return params.sessionsDirty && params.dirtySessionFileCount > 0;
}
