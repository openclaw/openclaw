import path from "node:path";
import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { parseVirtualAgentFsEntryKind } from "./agent-filesystem.js";
import type {
  VirtualAgentFs,
  VirtualAgentFsEntry,
  VirtualAgentFsEntryKind,
  VirtualAgentFsExportEntry,
  VirtualAgentFsListOptions,
  VirtualAgentFsRemoveOptions,
  VirtualAgentFsWriteOptions,
} from "./agent-filesystem.js";

type VfsEntriesTable = OpenClawAgentKyselyDatabase["vfs_entries"];
type VirtualAgentFsDatabase = Pick<OpenClawAgentKyselyDatabase, "vfs_entries">;

type VirtualAgentFsRow = Selectable<VfsEntriesTable> & {
  kind: string;
};

export type SqliteVirtualAgentFsOptions = OpenClawAgentDatabaseOptions & {
  agentId: string;
  namespace: string;
  now?: () => number;
};

function normalizeVfsPath(input: string): string {
  if (input.includes("\0")) {
    throw new Error("VFS path must not contain NUL bytes.");
  }
  if (!input || input === ".") {
    return "/";
  }
  const normalized = path.posix.normalize(`/${input}`).replace(/\/+$/u, "");
  return normalized || "/";
}

function isDescendantPath(candidatePath: string, parentPath: string): boolean {
  return parentPath === "/" ? candidatePath !== "/" : candidatePath.startsWith(`${parentPath}/`);
}

function descendantPrefix(parentPath: string): string {
  return parentPath === "/" ? "/" : `${parentPath}/`;
}

function prefixUpperBound(prefix: string): string {
  return prefix === "/" ? "0" : `${prefix.slice(0, -1)}0`;
}

function parentPathsFor(filePath: string): string[] {
  const normalized = normalizeVfsPath(filePath);
  const parents: string[] = [];
  let current = path.posix.dirname(normalized);
  while (current && current !== "/" && !parents.includes(current)) {
    parents.unshift(current);
    current = path.posix.dirname(current);
  }
  if (!parents.includes("/")) {
    parents.unshift("/");
  }
  return parents;
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function rowToEntry(row: VirtualAgentFsRow): VirtualAgentFsEntry {
  const kind = parseVirtualAgentFsEntryKind(row.kind);
  const contentSize = row.content_blob?.byteLength ?? 0;
  const updatedAt = typeof row.updated_at === "bigint" ? Number(row.updated_at) : row.updated_at;
  return {
    path: row.path,
    kind,
    size: kind === "file" ? contentSize : 0,
    metadata: parseMetadata(row.metadata_json),
    updatedAt,
  };
}

function bindEntry(params: {
  namespace: string;
  path: string;
  kind: VirtualAgentFsEntryKind;
  content: Buffer | null;
  metadata: Record<string, unknown>;
  updatedAt: number;
}): Insertable<VfsEntriesTable> {
  return {
    namespace: params.namespace,
    path: params.path,
    kind: params.kind,
    content_blob: params.content,
    metadata_json: JSON.stringify(params.metadata),
    updated_at: params.updatedAt,
  };
}

export class SqliteVirtualAgentFs implements VirtualAgentFs {
  readonly #options: SqliteVirtualAgentFsOptions;

  constructor(options: SqliteVirtualAgentFsOptions) {
    this.#options = options;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #selectRow(filePath: string): VirtualAgentFsRow | null {
    const database = openOpenClawAgentDatabase(this.#options);
    const db = getNodeSqliteKysely<VirtualAgentFsDatabase>(database.db);
    return (
      executeSqliteQueryTakeFirstSync<VirtualAgentFsRow>(
        database.db,
        db
          .selectFrom("vfs_entries")
          .select(["path", "kind", "content_blob", "metadata_json", "updated_at"])
          .where("namespace", "=", this.#options.namespace)
          .where("path", "=", normalizeVfsPath(filePath)),
      ) ?? null
    );
    return row ? virtualAgentFsRowFromDb(row) : null;
  }

  #rowsWithPrefix(prefix: string): VirtualAgentFsRow[] {
    const database = openOpenClawAgentDatabase(this.#options);
    const db = getNodeSqliteKysely<VirtualAgentFsDatabase>(database.db);
    return executeSqliteQuerySync<VirtualAgentFsRow>(
      database.db,
      db
        .selectFrom("vfs_entries")
        .select(["path", "kind", "content_blob", "metadata_json", "updated_at"])
        .where("namespace", "=", this.#options.namespace)
        .where("path", ">=", prefix)
        .where("path", "<", prefixUpperBound(prefix))
        .orderBy("path", "asc"),
    ).rows;
  }

  #rowsAtOrUnder(filePath: string): VirtualAgentFsRow[] {
    const normalized = normalizeVfsPath(filePath);
    if (normalized === "/") {
      return this.#rowsWithPrefix("/");
    }
    const row = this.#selectRow(normalized);
    return [...(row ? [row] : []), ...this.#rowsWithPrefix(descendantPrefix(normalized))];
  }

  #descendantRows(filePath: string): VirtualAgentFsRow[] {
    return this.#rowsWithPrefix(descendantPrefix(normalizeVfsPath(filePath)));
  }

  #upsert(params: {
    path: string;
    kind: VirtualAgentFsEntryKind;
    content: Buffer | null;
    metadata?: Record<string, unknown>;
    updatedAt: number;
  }): void {
    const database = openOpenClawAgentDatabase(this.#options);
    const db = getNodeSqliteKysely<VirtualAgentFsDatabase>(database.db);
    const row = bindEntry({
      namespace: this.#options.namespace,
      path: params.path,
      kind: params.kind,
      content: params.content,
      metadata: params.metadata ?? {},
      updatedAt: params.updatedAt,
    });
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("vfs_entries")
        .values(row)
        .onConflict((conflict) =>
          conflict.columns(["namespace", "path"]).doUpdateSet({
            kind: row.kind,
            content_blob: row.content_blob,
            metadata_json: row.metadata_json,
            updated_at: row.updated_at,
          }),
        ),
    );
  }

  #ensureParents(filePath: string, updatedAt: number): void {
    for (const parentPath of parentPathsFor(filePath)) {
      const existing = this.#selectRow(parentPath);
      if (existing) {
        if (parseVirtualAgentFsEntryKind(existing.kind) !== "directory") {
          throw new Error(`VFS parent is not a directory: ${parentPath}`);
        }
        continue;
      }
      this.#upsert({
        path: parentPath,
        kind: "directory",
        content: null,
        updatedAt,
      });
    }
  }

  stat(filePath: string): VirtualAgentFsEntry | null {
    const row = this.#selectRow(filePath);
    return row ? rowToEntry(row) : null;
  }

  readFile(filePath: string): Buffer {
    const row = this.#selectRow(filePath);
    if (!row || parseVirtualAgentFsEntryKind(row.kind) !== "file") {
      throw new Error(`VFS file not found: ${normalizeVfsPath(filePath)}`);
    }
    return Buffer.from(row.content_blob ?? Buffer.alloc(0));
  }

  writeFile(
    filePath: string,
    content: Buffer | string,
    options: VirtualAgentFsWriteOptions = {},
  ): void {
    const normalized = normalizeVfsPath(filePath);
    if (normalized === "/") {
      throw new Error("VFS cannot write a file at root.");
    }
    const updatedAt = this.#now();
    runOpenClawAgentWriteTransaction(() => {
      this.#ensureParents(normalized, updatedAt);
      const existing = this.#selectRow(normalized);
      if (existing && parseVirtualAgentFsEntryKind(existing.kind) !== "file") {
        throw new Error(`VFS path is a directory: ${normalized}`);
      }
      if (this.#descendantRows(normalized).length > 0) {
        throw new Error(`VFS path is a directory: ${normalized}`);
      }
      this.#upsert({
        path: normalized,
        kind: "file",
        content: Buffer.isBuffer(content) ? content : Buffer.from(content),
        metadata: options.metadata,
        updatedAt,
      });
    }, this.#options);
  }

  mkdir(dirPath: string, options: VirtualAgentFsWriteOptions = {}): void {
    const normalized = normalizeVfsPath(dirPath);
    const updatedAt = this.#now();
    runOpenClawAgentWriteTransaction(() => {
      this.#ensureParents(normalized, updatedAt);
      const existing = this.#selectRow(normalized);
      if (existing && parseVirtualAgentFsEntryKind(existing.kind) !== "directory") {
        throw new Error(`VFS path is not a directory: ${normalized}`);
      }
      this.#upsert({
        path: normalized,
        kind: "directory",
        content: null,
        metadata: options.metadata,
        updatedAt,
      });
    }, this.#options);
  }

  readdir(dirPath: string): VirtualAgentFsEntry[] {
    const normalized = normalizeVfsPath(dirPath);
    const prefix = descendantPrefix(normalized);
    return this.#rowsWithPrefix(prefix)
      .filter((row) => {
        const rest = row.path.slice(prefix.length);
        return rest.length > 0 && !rest.includes("/");
      })
      .map(rowToEntry);
  }

  list(rootPath = "/", options: VirtualAgentFsListOptions = {}): VirtualAgentFsEntry[] {
    const normalized = normalizeVfsPath(rootPath);
    const prefix = descendantPrefix(normalized);
    return this.#rowsAtOrUnder(normalized)
      .filter((row) => {
        if (options.recursive) {
          return true;
        }
        if (row.path === normalized) {
          return true;
        }
        const rest = row.path.slice(prefix.length);
        return rest.length > 0 && !rest.includes("/");
      })
      .map(rowToEntry);
  }

  export(rootPath = "/", options: VirtualAgentFsListOptions = {}): VirtualAgentFsExportEntry[] {
    const normalized = normalizeVfsPath(rootPath);
    const prefix = descendantPrefix(normalized);
    return this.#rowsAtOrUnder(normalized)
      .filter((row) => {
        if (options.recursive) {
          return true;
        }
        if (row.path === normalized) {
          return true;
        }
        const rest = row.path.slice(prefix.length);
        return rest.length > 0 && !rest.includes("/");
      })
      .map((row) => {
        const entry: VirtualAgentFsExportEntry = rowToEntry(row);
        if (parseVirtualAgentFsEntryKind(row.kind) === "file") {
          entry.contentBase64 = Buffer.from(row.content_blob ?? Buffer.alloc(0)).toString("base64");
        }
        return entry;
      });
  }

  remove(filePath: string, options: VirtualAgentFsRemoveOptions = {}): void {
    const normalized = normalizeVfsPath(filePath);
    const descendants = this.#descendantRows(normalized);
    if (descendants.length > 0 && !options.recursive) {
      throw new Error(`VFS directory is not empty: ${normalized}`);
    }
    runOpenClawAgentWriteTransaction((database) => {
      const db = getNodeSqliteKysely<VirtualAgentFsDatabase>(database.db);
      const prefix = descendantPrefix(normalized);
      const query =
        normalized === "/"
          ? db.deleteFrom("vfs_entries").where("namespace", "=", this.#options.namespace)
          : db
              .deleteFrom("vfs_entries")
              .where("namespace", "=", this.#options.namespace)
              .where((eb) =>
                eb.or([
                  eb("path", "=", normalized),
                  eb.and([eb("path", ">=", prefix), eb("path", "<", prefixUpperBound(prefix))]),
                ]),
              );
      executeSqliteQuerySync(database.db, query);
    }, this.#options);
  }

  rename(fromPath: string, toPath: string): void {
    const from = normalizeVfsPath(fromPath);
    const to = normalizeVfsPath(toPath);
    if (from === "/") {
      throw new Error("VFS cannot rename root.");
    }
    if (to === "/") {
      throw new Error("VFS cannot rename a path to root.");
    }
    if (from === to) {
      return;
    }
    if (isDescendantPath(to, from)) {
      throw new Error(`VFS cannot move a path into itself: ${from} -> ${to}`);
    }
    const updatedAt = this.#now();
    const rows = this.#rowsAtOrUnder(from);
    if (rows.length === 0) {
      throw new Error(`VFS path not found: ${from}`);
    }
    if (this.#selectRow(to) || this.#descendantRows(to).length > 0) {
      throw new Error(`VFS target already exists: ${to}`);
    }
    runOpenClawAgentWriteTransaction((database) => {
      this.#ensureParents(to, updatedAt);
      const db = getNodeSqliteKysely<VirtualAgentFsDatabase>(database.db);
      for (const row of rows) {
        const suffix = row.path === from ? "" : row.path.slice(from.length);
        executeSqliteQuerySync(
          database.db,
          db
            .deleteFrom("vfs_entries")
            .where("namespace", "=", this.#options.namespace)
            .where("path", "=", row.path),
        );
        this.#upsert({
          path: `${to}${suffix}`,
          kind: parseVirtualAgentFsEntryKind(row.kind),
          content: row.content_blob ? Buffer.from(row.content_blob) : null,
          metadata: parseMetadata(row.metadata_json),
          updatedAt,
        });
      }
    }, this.#options);
  }
}

export function createSqliteVirtualAgentFs(
  options: SqliteVirtualAgentFsOptions,
): SqliteVirtualAgentFs {
  return new SqliteVirtualAgentFs(options);
}
