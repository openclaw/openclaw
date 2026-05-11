import type { SQLInputValue } from "node:sqlite";
import {
  MEMORY_INDEX_TABLE_NAMES,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export type MemorySourceFileStateRow = {
  sourceKey: string;
  path: string | null;
  hash: string;
};

type MemorySourceStateDb = {
  prepare: (sql: string) => {
    all: (...args: SQLInputValue[]) => unknown;
    get: (...args: SQLInputValue[]) => unknown;
  };
};

export const MEMORY_SOURCE_FILE_STATE_SQL = `SELECT source_key as sourceKey, path, hash FROM ${MEMORY_INDEX_TABLE_NAMES.sources} WHERE source_kind = ?`;
export const MEMORY_SOURCE_FILE_HASH_SQL = `SELECT hash FROM ${MEMORY_INDEX_TABLE_NAMES.sources} WHERE source_key = ? AND source_kind = ?`;

export function loadMemorySourceFileState(params: {
  db: MemorySourceStateDb;
  source: MemorySource;
}): {
  rows: MemorySourceFileStateRow[];
  hashes: Map<string, string>;
} {
  const rows = params.db.prepare(MEMORY_SOURCE_FILE_STATE_SQL).all(params.source) as
    | MemorySourceFileStateRow[]
    | undefined;
  const normalizedRows = rows ?? [];
  return {
    rows: normalizedRows,
    hashes: new Map(normalizedRows.map((row) => [row.sourceKey, row.hash])),
  };
}

export function resolveMemorySourceExistingHash(params: {
  db: MemorySourceStateDb;
  source: MemorySource;
  sourceKey: string;
  existingHashes?: Map<string, string> | null;
}): string | undefined {
  if (params.existingHashes) {
    return params.existingHashes.get(params.sourceKey);
  }
  return (
    params.db.prepare(MEMORY_SOURCE_FILE_HASH_SQL).get(params.sourceKey, params.source) as
      | { hash: string }
      | undefined
  )?.hash;
}
