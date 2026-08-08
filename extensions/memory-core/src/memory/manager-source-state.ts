// Memory Core plugin module implements manager source state behavior.
import type { SQLInputValue } from "node:sqlite";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export type MemorySourceFileStateRow = {
  path: string;
  hash: string;
  mtime?: number;
  size?: number;
};

type MemorySourceFileMetadata = {
  path: string;
  mtime: number;
  size: number;
};

type MemorySourceStateDb = {
  prepare: (sql: string) => {
    all: (...args: SQLInputValue[]) => unknown;
    get: (...args: SQLInputValue[]) => unknown;
  };
};

const MEMORY_SOURCE_FILE_STATE_SQL = `SELECT path, hash, mtime, size FROM memory_index_sources WHERE source = ?`;
const MEMORY_SOURCE_FILE_HASH_SQL = `SELECT hash FROM memory_index_sources WHERE path = ? AND source = ?`;

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
    hashes: new Map(normalizedRows.map((row) => [row.path, row.hash])),
  };
}

function hasValidFileMetadata(
  value: Pick<MemorySourceFileStateRow, "path" | "mtime" | "size">,
): value is MemorySourceFileMetadata {
  return (
    value.path.length > 0 &&
    Number.isFinite(value.mtime) &&
    (value.mtime ?? -1) >= 0 &&
    Number.isSafeInteger(value.size) &&
    (value.size ?? -1) >= 0
  );
}

export function hasMemorySourceMetadataDrift(params: {
  files: Iterable<MemorySourceFileMetadata>;
  existingRows?: MemorySourceFileStateRow[] | null;
}): boolean {
  const existingRows = params.existingRows ?? [];
  const indexedByPath = new Map<string, MemorySourceFileStateRow>();
  for (const row of existingRows) {
    if (!hasValidFileMetadata(row) || row.hash.trim().length === 0 || indexedByPath.has(row.path)) {
      return true;
    }
    indexedByPath.set(row.path, row);
  }

  const activePaths = new Set<string>();
  for (const file of params.files) {
    if (!hasValidFileMetadata(file) || activePaths.has(file.path)) {
      return true;
    }
    activePaths.add(file.path);
    const indexed = indexedByPath.get(file.path);
    if (!indexed || indexed.mtime !== file.mtime || indexed.size !== file.size) {
      return true;
    }
  }
  return activePaths.size !== existingRows.length;
}

export function resolveMemorySourceExistingHash(params: {
  db: MemorySourceStateDb;
  source: MemorySource;
  path: string;
  existingHashes?: Map<string, string> | null;
}): string | undefined {
  if (params.existingHashes) {
    return params.existingHashes.get(params.path);
  }
  return (
    params.db.prepare(MEMORY_SOURCE_FILE_HASH_SQL).get(params.path, params.source) as
      | { hash: string }
      | undefined
  )?.hash;
}
