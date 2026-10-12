import type { DatabaseSync } from "node:sqlite";
import type { ResolvedMemorySearchConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildFileEntry,
  listMemoryFiles,
  runWithConcurrency,
  type MemoryFileEntry,
  type MemoryEntryProvenance,
  type MemorySource,
  type MemoryWorkspaceFiles,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";

type MemoryOriginClass = MemoryEntryProvenance["originClass"];

export type MemorySourceFileStateRow = {
  path: string;
  hash: string;
  mtime?: number;
  size?: number;
  origin?: MemoryOriginClass | null;
  hasChunks?: boolean;
};

type MemorySourceDatabase = {
  memory_index_sources: MemorySourceFileStateRow & { source: MemorySource };
  memory_index_chunks: { id: string; path: string; source: MemorySource };
  memory_index_chunk_provenance: { chunk_id: string; origin_class: MemoryOriginClass };
};

type MemorySourceInspection = {
  source: MemorySource;
  dirty: boolean;
  eligible: number | null;
  issues: string[];
};

/** Resolve exactly the entries eligible for indexing, including validated multimodal files. */
export async function resolveMemorySourceFileEntries(params: {
  workspaceDir: string;
  settings: Pick<ResolvedMemorySearchConfig, "extraPaths" | "multimodal">;
  concurrency: number;
  onSkippedSymlinkRoot?: (root: string) => void;
  files?: MemoryWorkspaceFiles;
}): Promise<MemoryFileEntry[]> {
  const files = await (params.files?.listFiles ?? listMemoryFiles)(
    params.workspaceDir,
    params.settings.extraPaths,
    params.settings.multimodal,
    params.onSkippedSymlinkRoot,
  );
  return (
    await runWithConcurrency(
      files.map(
        (file) => async () =>
          await (params.files?.inspectFile ?? buildFileEntry)(
            file,
            params.workspaceDir,
            params.settings.multimodal,
          ),
      ),
      params.concurrency,
    )
  ).filter((entry): entry is MemoryFileEntry => entry !== null);
}

export async function inspectMemorySourceState(params: {
  readIndexedRows: () => Promise<MemorySourceFileStateRow[]>;
  workspaceDir: string;
  settings: Pick<ResolvedMemorySearchConfig, "extraPaths" | "multimodal">;
  concurrency: number;
  files?: MemoryWorkspaceFiles;
}): Promise<MemorySourceInspection> {
  const skippedRoots = new Set<string>();
  const entries = await resolveMemorySourceFileEntries({
    ...params,
    onSkippedSymlinkRoot: (root) => skippedRoots.add(root),
  });
  const indexedByPath = new Map(
    (await params.readIndexedRows()).map((row) => [row.path, row.hash]),
  );
  return {
    source: "memory",
    dirty:
      indexedByPath.size !== entries.length ||
      entries.some((entry) => indexedByPath.get(entry.path) !== entry.hash),
    eligible: entries.length,
    issues: [
      ...(entries.length === 0 ? ["no eligible memory files found"] : []),
      ...Array.from(
        skippedRoots,
        (root) =>
          `extra path "${root}" is a symlink root; symlinked roots are not traversed, so configure its canonical absolute directory instead`,
      ),
    ],
  };
}

export function loadMemorySourceFileState(params: {
  db: DatabaseSync;
  source: MemorySource;
  paths?: readonly string[];
  includeOrigin?: boolean;
}): MemorySourceFileStateRow[] {
  let query = getNodeSqliteKysely<MemorySourceDatabase>(params.db)
    .selectFrom("memory_index_sources as file")
    .select(["file.path", "file.hash", "file.mtime", "file.size"])
    .where("file.source", "=", params.source);
  if (params.paths) {
    query = query.where("file.path", "in", sqliteStringSet(params.paths));
  }
  if (!params.includeOrigin || params.source !== "memory") {
    return executeSqliteQuerySync(params.db, query).rows;
  }
  // Memory-file chunks share their source's origin. Point reads avoid scanning
  // every chunk of an unchanged document; sessions retain per-line provenance.
  const rows = executeSqliteQuerySync(
    params.db,
    query
      .select((eb) =>
        eb
          .selectFrom("memory_index_chunks as chunk")
          .select("chunk.id")
          .whereRef("chunk.path", "=", "file.path")
          .whereRef("chunk.source", "=", "file.source")
          .limit(1)
          .as("chunkId"),
      )
      .select((eb) =>
        eb
          .selectFrom("memory_index_chunks as chunk")
          .leftJoin(
            "memory_index_chunk_provenance as provenance",
            "provenance.chunk_id",
            "chunk.id",
          )
          .select("provenance.origin_class")
          .whereRef("chunk.path", "=", "file.path")
          .whereRef("chunk.source", "=", "file.source")
          .limit(1)
          .as("origin"),
      ),
  ).rows;
  return rows.map((row) => ({
    path: row.path,
    hash: row.hash,
    mtime: row.mtime,
    size: row.size,
    origin: row.origin,
    hasChunks: row.chunkId !== null,
  }));
}

export function refreshMemorySessionSourceState(
  db: DatabaseSync,
  input: { path: string; hash: string; mtime: number; size: number; expectedHash: string },
): boolean {
  return (
    Number(
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<MemorySourceDatabase>(db)
          .updateTable("memory_index_sources")
          .set({ hash: input.hash, mtime: input.mtime, size: input.size })
          .where("path", "=", input.path)
          .where("source", "=", "sessions")
          .where("hash", "=", input.expectedHash),
      ).numAffectedRows,
    ) === 1
  );
}
