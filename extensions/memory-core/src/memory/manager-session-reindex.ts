import type { MemorySyncParams } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { hasTargetedSessionSyncParams } from "./manager-sync-control.js";

export function shouldSyncSessionsForReindex(params: {
  hasSessionSource: boolean;
  sessionsDirty: boolean;
  sessionsFullRetryDirty?: boolean;
  sync?: MemorySyncParams;
  needsFullReindex?: boolean;
}): boolean {
  if (!params.hasSessionSource) {
    return false;
  }
  if (
    hasTargetedSessionSyncParams(params.sync) ||
    params.sync?.force ||
    params.needsFullReindex ||
    params.sessionsFullRetryDirty
  ) {
    return true;
  }
  const reason = params.sync?.reason;
  if (reason === "session-start" || reason === "watch") {
    return false;
  }
  return params.sessionsDirty;
}
