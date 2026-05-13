import { type MemorySourceFileStateRow } from "./manager-source-state.js";

export type MemorySessionSyncScope = {
  agentId: string;
  sessionId: string;
};

export function resolveMemorySessionSyncPlan(params: {
  needsFullReindex: boolean;
  transcripts: MemorySessionSyncScope[];
  targetSessionTranscriptKeys: Set<string> | null;
  dirtySessionTranscripts: Set<string>;
  existingRows?: MemorySourceFileStateRow[] | null;
  sessionTranscriptSourceKeyForScope: (scope: MemorySessionSyncScope) => string;
}): {
  activeSourceKeys: Set<string> | null;
  existingRows: MemorySourceFileStateRow[] | null;
  existingHashes: Map<string, string> | null;
  indexAll: boolean;
} {
  const activeSourceKeys = params.targetSessionTranscriptKeys
    ? null
    : new Set(params.transcripts.map((scope) => params.sessionTranscriptSourceKeyForScope(scope)));
  const existingRows = activeSourceKeys === null ? null : (params.existingRows ?? []);
  return {
    activeSourceKeys,
    existingRows,
    existingHashes: existingRows
      ? new Map(existingRows.map((row) => [row.sourceKey, row.hash]))
      : null,
    indexAll:
      params.needsFullReindex ||
      Boolean(params.targetSessionTranscriptKeys) ||
      params.dirtySessionTranscripts.size === 0,
  };
}
