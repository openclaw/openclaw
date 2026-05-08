import { type MemorySourceFileStateRow } from "./manager-source-state.js";

export function resolveMemorySessionSyncPlan(params: {
  needsFullReindex: boolean;
  files: string[];
  targetSessionTranscripts: Set<string> | null;
  dirtySessionTranscripts: Set<string>;
  existingRows?: MemorySourceFileStateRow[] | null;
  sessionPathForTranscript: (file: string) => string;
}): {
  activePaths: Set<string> | null;
  existingRows: MemorySourceFileStateRow[] | null;
  existingHashes: Map<string, string> | null;
  indexAll: boolean;
} {
  const activePaths = params.targetSessionTranscripts
    ? null
    : new Set(params.files.map((file) => params.sessionPathForTranscript(file)));
  const existingRows = activePaths === null ? null : (params.existingRows ?? []);
  return {
    activePaths,
    existingRows,
    existingHashes: existingRows ? new Map(existingRows.map((row) => [row.path, row.hash])) : null,
    indexAll:
      params.needsFullReindex ||
      Boolean(params.targetSessionTranscripts) ||
      params.dirtySessionTranscripts.size === 0,
  };
}
