import path from "node:path";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type {
  AgentRunArtifact,
  AgentRunArtifactExport,
  AgentRunArtifactStore,
  AgentRunArtifactWriteOptions,
} from "./agent-filesystem.js";

export type SqliteRunArtifact = AgentRunArtifact;
export type SqliteRunArtifactExport = AgentRunArtifactExport;

export type SqliteRunArtifactStoreOptions = Omit<OpenClawAgentDatabaseOptions, "path"> & {
  agentId: string;
  runId: string;
};

export type WriteSqliteRunArtifactOptions = SqliteRunArtifactStoreOptions & {
  path: string;
  kind: string;
  metadata?: Record<string, unknown>;
  blob?: Buffer | string;
  now?: () => number;
};

type RunArtifactsTable = OpenClawAgentKyselyDatabase["run_artifacts"];
type RunArtifactDatabase = Pick<OpenClawAgentKyselyDatabase, "run_artifacts">;
type RunArtifactDatabaseOptions = Omit<OpenClawAgentDatabaseOptions, "path">;

type RunArtifactRow = Selectable<RunArtifactsTable>;

function normalizeRunId(value: string): string {
  const runId = value.trim();
  if (!runId) {
    throw new Error("SQLite run artifact store requires a run id.");
  }
  return runId;
}

function normalizeRunArtifactPath(value: string): string {
  if (value.includes("\0")) {
    throw new Error("SQLite run artifact path must not contain NUL bytes.");
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === ".") {
    throw new Error("SQLite run artifact path is required.");
  }
  const normalized = path.posix.normalize(`/${trimmed}`).replace(/\/+$/u, "");
  if (!normalized || normalized === "/") {
    throw new Error("SQLite run artifact path must identify a file.");
  }
  return normalized;
}

function normalizeKind(value: string): string {
  const kind = value.trim();
  if (!kind) {
    throw new Error("SQLite run artifact kind is required.");
  }
  return kind;
}

function normalizeScope(options: SqliteRunArtifactStoreOptions): {
  agentId: string;
  runId: string;
} {
  return {
    agentId: normalizeAgentId(options.agentId),
    runId: normalizeRunId(options.runId),
  };
}

function toDatabaseOptions(options: SqliteRunArtifactStoreOptions): RunArtifactDatabaseOptions {
  const { agentId, env } = options;
  return { agentId, ...(env ? { env } : {}) };
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

function rowToArtifact(
  row: RunArtifactRow,
  scope: { agentId: string; runId: string },
): SqliteRunArtifact {
  return {
    agentId: scope.agentId,
    runId: scope.runId,
    path: row.path,
    kind: row.kind,
    metadata: parseMetadata(row.metadata_json),
    size: row.blob?.byteLength ?? 0,
    createdAt: typeof row.created_at === "bigint" ? Number(row.created_at) : row.created_at,
  };
}

function rowToExport(
  row: RunArtifactRow,
  scope: { agentId: string; runId: string },
): SqliteRunArtifactExport {
  return {
    ...rowToArtifact(row, scope),
    ...(row.blob ? { blobBase64: Buffer.from(row.blob).toString("base64") } : {}),
  };
}

function filterRowsByPrefix(rows: RunArtifactRow[], prefix: string | undefined): RunArtifactRow[] {
  if (prefix === undefined) {
    return rows;
  }
  const normalizedPrefix = normalizeRunArtifactPath(prefix);
  return rows.filter(
    (row) => row.path === normalizedPrefix || row.path.startsWith(`${normalizedPrefix}/`),
  );
}

export function writeSqliteRunArtifact(options: WriteSqliteRunArtifactOptions): SqliteRunArtifact {
  const { agentId, runId } = normalizeScope(options);
  const artifactPath = normalizeRunArtifactPath(options.path);
  const databaseOptions = toDatabaseOptions(options);
  const kind = normalizeKind(options.kind);
  const createdAt = options.now?.() ?? Date.now();
  const metadataJson = JSON.stringify(options.metadata ?? {});
  const blob =
    options.blob === undefined
      ? null
      : Buffer.isBuffer(options.blob)
        ? options.blob
        : Buffer.from(options.blob);
  runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<RunArtifactDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("run_artifacts")
        .values({
          run_id: runId,
          path: artifactPath,
          kind,
          metadata_json: metadataJson,
          blob,
          created_at: createdAt,
        })
        .onConflict((conflict) =>
          conflict.columns(["run_id", "path"]).doUpdateSet({
            kind,
            metadata_json: metadataJson,
            blob,
            created_at: createdAt,
          }),
        ),
    );
  }, databaseOptions);
  return {
    agentId,
    runId,
    path: artifactPath,
    kind,
    metadata: options.metadata ?? {},
    size: blob?.byteLength ?? 0,
    createdAt,
  };
}

export function listSqliteRunArtifacts(
  options: SqliteRunArtifactStoreOptions & { prefix?: string },
): SqliteRunArtifact[] {
  const { agentId, runId } = normalizeScope(options);
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<RunArtifactDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("run_artifacts")
      .select(["run_id", "path", "kind", "metadata_json", "blob", "created_at"])
      .where("run_id", "=", runId)
      .orderBy("path", "asc"),
  ).rows;
  return filterRowsByPrefix(rows, options.prefix).map((row) =>
    rowToArtifact(row, { agentId, runId }),
  );
}

export function readSqliteRunArtifact(
  options: SqliteRunArtifactStoreOptions & { path: string },
): SqliteRunArtifactExport | null {
  const { agentId, runId } = normalizeScope(options);
  const artifactPath = normalizeRunArtifactPath(options.path);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(options));
  const db = getNodeSqliteKysely<RunArtifactDatabase>(database.db);
  const row =
    executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("run_artifacts")
        .select(["run_id", "path", "kind", "metadata_json", "blob", "created_at"])
        .where("run_id", "=", runId)
        .where("path", "=", artifactPath),
    ) ?? null;
  return row ? rowToExport(row, { agentId, runId }) : null;
}

export function exportSqliteRunArtifacts(
  options: SqliteRunArtifactStoreOptions & { prefix?: string },
): SqliteRunArtifactExport[] {
  const { agentId, runId } = normalizeScope(options);
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<RunArtifactDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("run_artifacts")
      .select(["run_id", "path", "kind", "metadata_json", "blob", "created_at"])
      .where("run_id", "=", runId)
      .orderBy("path", "asc"),
  ).rows;
  return filterRowsByPrefix(rows, options.prefix).map((row) =>
    rowToExport(row, { agentId, runId }),
  );
}

export function deleteSqliteRunArtifacts(options: SqliteRunArtifactStoreOptions): number {
  const { runId } = normalizeScope(options);
  return runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<RunArtifactDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      db.deleteFrom("run_artifacts").where("run_id", "=", runId),
    );
    return Number(result.numAffectedRows ?? 0);
  }, options);
}

export class SqliteRunArtifactStore implements AgentRunArtifactStore {
  readonly #options: SqliteRunArtifactStoreOptions;

  constructor(options: SqliteRunArtifactStoreOptions) {
    this.#options = options;
  }

  write(options: AgentRunArtifactWriteOptions): AgentRunArtifact {
    return writeSqliteRunArtifact({
      ...this.#options,
      ...options,
    });
  }

  list(prefix?: string): AgentRunArtifact[] {
    return listSqliteRunArtifacts({ ...this.#options, prefix });
  }

  read(path: string): AgentRunArtifactExport | null {
    return readSqliteRunArtifact({
      ...this.#options,
      path,
    });
  }

  export(prefix?: string): AgentRunArtifactExport[] {
    return exportSqliteRunArtifacts({ ...this.#options, prefix });
  }

  deleteAll(): number {
    return deleteSqliteRunArtifacts(this.#options);
  }
}

export function createSqliteRunArtifactStore(
  options: SqliteRunArtifactStoreOptions,
): SqliteRunArtifactStore {
  return new SqliteRunArtifactStore(options);
}
