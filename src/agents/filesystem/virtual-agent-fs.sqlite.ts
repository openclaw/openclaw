import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import type {
  VirtualAgentFs,
  VirtualAgentFsEntry,
  VirtualAgentFsEntryKind,
  VirtualAgentFsExportEntry,
  VirtualAgentFsListOptions,
  VirtualAgentFsRemoveOptions,
  VirtualAgentFsWriteOptions,
} from "./agent-filesystem.js";

type VirtualAgentFsRow = {
  path: string;
  kind: VirtualAgentFsEntryKind;
  content_blob: Buffer | null;
  metadata_json: string;
  updated_at: number | bigint;
};

export type SqliteVirtualAgentFsOptions = OpenClawStateDatabaseOptions & {
  agentId: string;
  namespace: string;
  now?: () => number;
};

function normalizeVfsPath(input: string): string {
  if (input.includes("\0")) {
    throw new Error("VFS path must not contain NUL bytes.");
  }
  const trimmed = input.trim();
  if (!trimmed || trimmed === ".") {
    return "/";
  }
  const normalized = path.posix.normalize(`/${trimmed}`).replace(/\/+$/u, "");
  return normalized || "/";
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
  const contentSize = row.content_blob?.byteLength ?? 0;
  const updatedAt = typeof row.updated_at === "bigint" ? Number(row.updated_at) : row.updated_at;
  return {
    path: row.path,
    kind: row.kind,
    size: row.kind === "file" ? contentSize : 0,
    metadata: parseMetadata(row.metadata_json),
    updatedAt,
  };
}

function bindEntry(params: {
  agentId: string;
  namespace: string;
  path: string;
  kind: VirtualAgentFsEntryKind;
  content: Buffer | null;
  metadata: Record<string, unknown>;
  updatedAt: number;
}): Record<string, SQLInputValue> {
  return {
    agent_id: params.agentId,
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
    const database = openOpenClawStateDatabase(this.#options);
    return (
      (database.db
        .prepare(
          `
            SELECT path, kind, content_blob, metadata_json, updated_at
            FROM vfs_entries
            WHERE agent_id = ?
              AND namespace = ?
              AND path = ?
          `,
        )
        .get(this.#options.agentId, this.#options.namespace, normalizeVfsPath(filePath)) as
        | VirtualAgentFsRow
        | undefined) ?? null
    );
  }

  #allRows(): VirtualAgentFsRow[] {
    const database = openOpenClawStateDatabase(this.#options);
    return database.db
      .prepare(
        `
          SELECT path, kind, content_blob, metadata_json, updated_at
          FROM vfs_entries
          WHERE agent_id = ?
            AND namespace = ?
          ORDER BY path ASC
        `,
      )
      .all(this.#options.agentId, this.#options.namespace) as VirtualAgentFsRow[];
  }

  #upsert(params: {
    path: string;
    kind: VirtualAgentFsEntryKind;
    content: Buffer | null;
    metadata?: Record<string, unknown>;
    updatedAt: number;
  }): void {
    const database = openOpenClawStateDatabase(this.#options);
    database.db
      .prepare(
        `
          INSERT INTO vfs_entries (
            agent_id,
            namespace,
            path,
            kind,
            content_blob,
            metadata_json,
            updated_at
          ) VALUES (
            @agent_id,
            @namespace,
            @path,
            @kind,
            @content_blob,
            @metadata_json,
            @updated_at
          )
          ON CONFLICT(agent_id, namespace, path) DO UPDATE SET
            kind = excluded.kind,
            content_blob = excluded.content_blob,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        bindEntry({
          agentId: this.#options.agentId,
          namespace: this.#options.namespace,
          path: params.path,
          kind: params.kind,
          content: params.content,
          metadata: params.metadata ?? {},
          updatedAt: params.updatedAt,
        }),
      );
  }

  #ensureParents(filePath: string, updatedAt: number): void {
    for (const parentPath of parentPathsFor(filePath)) {
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
    if (!row || row.kind !== "file") {
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
    const updatedAt = this.#now();
    runOpenClawStateWriteTransaction(() => {
      this.#ensureParents(normalized, updatedAt);
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
    runOpenClawStateWriteTransaction(() => {
      this.#ensureParents(normalized, updatedAt);
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
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    return this.#allRows()
      .filter((row) => row.path !== normalized && row.path.startsWith(prefix))
      .filter((row) => {
        const rest = row.path.slice(prefix.length);
        return rest.length > 0 && !rest.includes("/");
      })
      .map(rowToEntry);
  }

  list(rootPath = "/", options: VirtualAgentFsListOptions = {}): VirtualAgentFsEntry[] {
    const normalized = normalizeVfsPath(rootPath);
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    return this.#allRows()
      .filter((row) => row.path === normalized || row.path.startsWith(prefix))
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
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    return this.#allRows()
      .filter((row) => row.path === normalized || row.path.startsWith(prefix))
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
        if (row.kind === "file") {
          entry.contentBase64 = Buffer.from(row.content_blob ?? Buffer.alloc(0)).toString("base64");
        }
        return entry;
      });
  }

  remove(filePath: string, options: VirtualAgentFsRemoveOptions = {}): void {
    const normalized = normalizeVfsPath(filePath);
    const descendants = this.#allRows().filter((row) => row.path.startsWith(`${normalized}/`));
    if (descendants.length > 0 && !options.recursive) {
      throw new Error(`VFS directory is not empty: ${normalized}`);
    }
    runOpenClawStateWriteTransaction((database) => {
      database.db
        .prepare(
          `
            DELETE FROM vfs_entries
            WHERE agent_id = ?
              AND namespace = ?
              AND (path = ? OR path LIKE ?)
          `,
        )
        .run(this.#options.agentId, this.#options.namespace, normalized, `${normalized}/%`);
    }, this.#options);
  }

  rename(fromPath: string, toPath: string): void {
    const from = normalizeVfsPath(fromPath);
    const to = normalizeVfsPath(toPath);
    const updatedAt = this.#now();
    const rows = this.#allRows().filter(
      (row) => row.path === from || row.path.startsWith(`${from}/`),
    );
    if (rows.length === 0) {
      throw new Error(`VFS path not found: ${from}`);
    }
    runOpenClawStateWriteTransaction((database) => {
      this.#ensureParents(to, updatedAt);
      const deleteStatement = database.db.prepare(
        `
          DELETE FROM vfs_entries
          WHERE agent_id = ?
            AND namespace = ?
            AND path = ?
        `,
      );
      for (const row of rows) {
        const suffix = row.path === from ? "" : row.path.slice(from.length);
        deleteStatement.run(this.#options.agentId, this.#options.namespace, row.path);
        this.#upsert({
          path: `${to}${suffix}`,
          kind: row.kind,
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
