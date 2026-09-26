import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { MemorySyncProgressState } from "./manager-sync-base.js";

export function markMemoryTargetArchiveFilesDirty(params: {
  sessionsDirtyFiles: Set<string>;
  targetArchiveFiles?: Iterable<string> | null;
}): boolean {
  if (params.targetArchiveFiles) {
    for (const targetArchiveFile of params.targetArchiveFiles) {
      params.sessionsDirtyFiles.add(targetArchiveFile);
    }
  }
  return params.sessionsDirtyFiles.size > 0;
}

export async function runMemoryTargetedSessionSync(params: {
  hasSessionSource: boolean;
  targetArchiveFiles: Set<string> | null;
  reason?: string;
  progress?: MemorySyncProgressState;
  sessionsFullRetryDirty?: boolean;
  sessionsReconcileDirty?: boolean;
  sessionsDirtyFiles: Set<string>;
  syncArchiveFiles: (params: {
    needsFullReindex: boolean;
    targetArchiveFiles?: string[];
    progress?: MemorySyncProgressState;
  }) => Promise<void>;
  shouldFallbackOnError: (err: unknown) => boolean;
  activateFallbackProvider: (reason: string) => Promise<boolean>;
}): Promise<
  | { handled: false; sessionsDirty: boolean }
  | { handled: true; sessionsDirty: boolean; failure?: never }
  | { handled: true; sessionsDirty: boolean; failure: { error: unknown } }
> {
  const hasPendingSessionWork = () =>
    params.sessionsFullRetryDirty ||
    params.sessionsReconcileDirty ||
    params.sessionsDirtyFiles.size > 0;
  if (!params.hasSessionSource || !params.targetArchiveFiles) {
    return {
      handled: false,
      sessionsDirty: hasPendingSessionWork(),
    };
  }

  try {
    await params.syncArchiveFiles({
      needsFullReindex: false,
      targetArchiveFiles: Array.from(params.targetArchiveFiles),
      progress: params.progress,
    });
    for (const file of params.targetArchiveFiles) {
      params.sessionsDirtyFiles.delete(file);
    }
    return {
      handled: true,
      sessionsDirty: hasPendingSessionWork(),
    };
  } catch (err) {
    const reason = formatErrorMessage(err);
    const activated =
      params.shouldFallbackOnError(err) && (await params.activateFallbackProvider(reason));
    if (!activated) {
      throw err;
    }
    markMemoryTargetArchiveFilesDirty({
      sessionsDirtyFiles: params.sessionsDirtyFiles,
      targetArchiveFiles: params.targetArchiveFiles,
    });
    return {
      handled: true,
      sessionsDirty: hasPendingSessionWork(),
      failure: { error: err },
    };
  }
}
