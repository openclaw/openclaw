import {
  isCronRunSessionKey,
  isDreamingNarrativeSessionStoreKey,
  type SessionFileEntry,
  type SessionFileState,
  type SessionTranscriptCorpusEntry,
} from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import type { MemorySourceFileStateRow } from "./manager-source-state.js";

export type MemorySessionStartupFileState = SessionFileState;

export function isMemorySessionIndexable(
  entry: Pick<
    SessionTranscriptCorpusEntry,
    "generatedByDreamingNarrative" | "generatedByCronRun" | "sessionKind"
  > &
    Partial<Pick<SessionFileEntry, "lineProvenance">>,
  archivedSessionKey?: string,
): boolean {
  return !(
    entry.generatedByDreamingNarrative ||
    entry.generatedByCronRun ||
    entry.sessionKind === "cron" ||
    entry.sessionKind === "heartbeat" ||
    (archivedSessionKey !== undefined &&
      (isDreamingNarrativeSessionStoreKey(archivedSessionKey) ||
        isCronRunSessionKey(archivedSessionKey) ||
        archivedSessionKey.endsWith(":heartbeat"))) ||
    (entry.lineProvenance !== undefined &&
      entry.lineProvenance.length > 0 &&
      entry.lineProvenance.every((line) => line.originClass === "system"))
  );
}

export function resolveMemorySessionStartupState(params: {
  files: MemorySessionStartupFileState[];
  existingRows?: MemorySourceFileStateRow[] | null;
}): { dirtyFiles: string[]; hasStaleIndexedPaths: boolean } {
  const existingRows = params.existingRows ?? [];
  const indexedRows = new Map(existingRows.map((row) => [row.path, row]));
  const activePaths = new Set(params.files.map((file) => file.path));
  const dirtyFiles: string[] = [];
  for (const file of params.files) {
    const existing = indexedRows.get(file.path);
    if (!existing || existing.hash === "") {
      dirtyFiles.push(file.absPath);
      continue;
    }
    const indexedMtimeMs = Number(existing.mtime);
    const indexedSize = Number(existing.size);
    if (!Number.isFinite(indexedMtimeMs) || !Number.isFinite(indexedSize)) {
      dirtyFiles.push(file.absPath);
      continue;
    }
    // Activity and transcript revisions can move backward after
    // restore/reset. The downstream content-hash gate suppresses unchanged rewrites.
    if (
      file.size !== indexedSize ||
      file.mtimeMs !== indexedMtimeMs ||
      (file.revisionMs !== undefined && !existing.hash.startsWith(`sqlite:${file.revisionMs}:`))
    ) {
      dirtyFiles.push(file.absPath);
    }
  }
  return {
    dirtyFiles,
    hasStaleIndexedPaths: existingRows.some((row) => !activePaths.has(row.path)),
  };
}

export function resolveMemorySessionSyncPlan(params: {
  needsFullReindex: boolean;
  files: string[];
  targetSessionFiles: Set<string> | null;
  existingRows?: MemorySourceFileStateRow[] | null;
  sessionPathForFile: (file: string) => string;
}): {
  activePaths: Set<string> | null;
  existingRows: MemorySourceFileStateRow[] | null;
  existingHashes: Map<string, string> | null;
  indexAll: boolean;
} {
  const activePaths = params.targetSessionFiles
    ? null
    : new Set(params.files.map((file) => params.sessionPathForFile(file)));
  const existingRows = activePaths === null ? null : (params.existingRows ?? []);
  return {
    activePaths,
    existingRows,
    existingHashes: existingRows ? new Map(existingRows.map((row) => [row.path, row.hash])) : null,
    indexAll: params.needsFullReindex || Boolean(params.targetSessionFiles),
  };
}
