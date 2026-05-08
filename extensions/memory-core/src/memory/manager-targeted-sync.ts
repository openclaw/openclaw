import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { MemorySyncProgressUpdate } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

type TargetedSyncProgress = {
  completed: number;
  total: number;
  label?: string;
  report: (update: MemorySyncProgressUpdate) => void;
};

export function clearMemorySyncedSessionTranscripts(params: {
  dirtySessionTranscripts: Set<string>;
  targetSessionTranscripts?: Iterable<string> | null;
}): boolean {
  if (!params.targetSessionTranscripts) {
    params.dirtySessionTranscripts.clear();
  } else {
    for (const targetSessionTranscript of params.targetSessionTranscripts) {
      params.dirtySessionTranscripts.delete(targetSessionTranscript);
    }
  }
  return params.dirtySessionTranscripts.size > 0;
}

export async function runMemoryTargetedSessionSync(params: {
  hasSessionSource: boolean;
  targetSessionTranscripts: Set<string> | null;
  reason?: string;
  progress?: TargetedSyncProgress;
  useUnsafeReindex: boolean;
  dirtySessionTranscripts: Set<string>;
  syncSessionTranscripts: (params: {
    needsFullReindex: boolean;
    targetSessionTranscripts?: string[];
    progress?: TargetedSyncProgress;
  }) => Promise<void>;
  shouldFallbackOnError: (message: string) => boolean;
  activateFallbackProvider: (reason: string) => Promise<boolean>;
  runSafeReindex: (params: {
    reason?: string;
    force?: boolean;
    progress?: TargetedSyncProgress;
  }) => Promise<void>;
  runUnsafeReindex: (params: {
    reason?: string;
    force?: boolean;
    progress?: TargetedSyncProgress;
  }) => Promise<void>;
}): Promise<{ handled: boolean; sessionsDirty: boolean }> {
  if (!params.hasSessionSource || !params.targetSessionTranscripts) {
    return {
      handled: false,
      sessionsDirty: params.dirtySessionTranscripts.size > 0,
    };
  }

  try {
    await params.syncSessionTranscripts({
      needsFullReindex: false,
      targetSessionTranscripts: Array.from(params.targetSessionTranscripts),
      progress: params.progress,
    });
    return {
      handled: true,
      sessionsDirty: clearMemorySyncedSessionTranscripts({
        dirtySessionTranscripts: params.dirtySessionTranscripts,
        targetSessionTranscripts: params.targetSessionTranscripts,
      }),
    };
  } catch (err) {
    const reason = formatErrorMessage(err);
    const activated =
      params.shouldFallbackOnError(reason) && (await params.activateFallbackProvider(reason));
    if (!activated) {
      throw err;
    }
    const reindexParams = {
      reason: params.reason,
      force: true,
      progress: params.progress,
    };
    if (params.useUnsafeReindex) {
      await params.runUnsafeReindex(reindexParams);
    } else {
      await params.runSafeReindex(reindexParams);
    }
    return {
      handled: true,
      sessionsDirty: params.dirtySessionTranscripts.size > 0,
    };
  }
}
