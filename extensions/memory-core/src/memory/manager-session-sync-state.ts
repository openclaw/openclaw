import { type MemorySourceFileStateRow } from "./manager-source-state.js";

export type MemorySessionSyncScope = {
  agentId: string;
  sessionId: string;
};

export function resolveMemorySessionSyncPlan(params: {
  needsFullReindex: boolean;
  files: MemorySessionSyncScope[];
  targetSessionTranscriptKeys: Set<string> | null;
  dirtySessionTranscripts: Set<string>;
  existingRows?: MemorySourceFileStateRow[] | null;
  sessionPathForTranscript: (scope: MemorySessionSyncScope) => string;
}): {
  activePaths: Set<string> | null;
  existingRows: MemorySourceFileStateRow[] | null;
  existingHashes: Map<string, string> | null;
  indexAll: boolean;
} {
  const activePaths = params.targetSessionTranscriptKeys
    ? null
    : new Set(params.files.map((file) => params.sessionPathForTranscript(file)));
  const existingRows = activePaths === null ? null : (params.existingRows ?? []);
  return {
    activePaths,
    existingRows,
    existingHashes: existingRows ? new Map(existingRows.map((row) => [row.path, row.hash])) : null,
    indexAll:
      params.needsFullReindex ||
      Boolean(params.targetSessionTranscriptKeys) ||
      params.dirtySessionTranscripts.size === 0,
  };
}
