import { randomUUID } from "node:crypto";
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
  AgentToolArtifact,
  AgentToolArtifactExport,
  AgentToolArtifactStore,
  AgentToolArtifactWriteOptions,
} from "./agent-filesystem.js";

export type SqliteToolArtifact = AgentToolArtifact;
export type SqliteToolArtifactExport = AgentToolArtifactExport;

export type SqliteToolArtifactStoreOptions = OpenClawAgentDatabaseOptions & {
  agentId: string;
  runId: string;
};

export type WriteSqliteToolArtifactOptions = SqliteToolArtifactStoreOptions & {
  artifactId?: string;
  kind: string;
  metadata?: Record<string, unknown>;
  blob?: Buffer | string;
  now?: () => number;
};

type ToolArtifactsTable = OpenClawAgentKyselyDatabase["tool_artifacts"];
type ToolArtifactDatabase = Pick<OpenClawAgentKyselyDatabase, "tool_artifacts">;

type ToolArtifactRow = Selectable<ToolArtifactsTable>;

function normalizeRunId(value: string): string {
  const runId = value.trim();
  if (!runId) {
    throw new Error("SQLite tool artifact store requires a run id.");
  }
  return runId;
}

function normalizeArtifactId(value: string | undefined): string {
  const artifactId = value?.trim() || randomUUID();
  if (artifactId.includes("\0")) {
    throw new Error("SQLite tool artifact id must not contain NUL bytes.");
  }
  return artifactId;
}

function normalizeKind(value: string): string {
  const kind = value.trim();
  if (!kind) {
    throw new Error("SQLite tool artifact kind is required.");
  }
  return kind;
}

function normalizeScope(options: SqliteToolArtifactStoreOptions): {
  agentId: string;
  runId: string;
} {
  return {
    agentId: normalizeAgentId(options.agentId),
    runId: normalizeRunId(options.runId),
  };
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
  row: ToolArtifactRow,
  scope: { agentId: string; runId: string },
): SqliteToolArtifact {
  return {
    agentId: scope.agentId,
    runId: scope.runId,
    artifactId: row.artifact_id,
    kind: row.kind,
    metadata: parseMetadata(row.metadata_json),
    size: row.blob?.byteLength ?? 0,
    createdAt: typeof row.created_at === "bigint" ? Number(row.created_at) : row.created_at,
  };
}

function rowToExport(
  row: ToolArtifactRow,
  scope: { agentId: string; runId: string },
): SqliteToolArtifactExport {
  return {
    ...rowToArtifact(row, scope),
    ...(row.blob ? { blobBase64: Buffer.from(row.blob).toString("base64") } : {}),
  };
}

export function writeSqliteToolArtifact(
  options: WriteSqliteToolArtifactOptions,
): SqliteToolArtifact {
  const { agentId, runId } = normalizeScope(options);
  const artifactId = normalizeArtifactId(options.artifactId);
  const kind = normalizeKind(options.kind);
  const createdAt = options.now?.() ?? Date.now();
  const blob =
    options.blob === undefined
      ? null
      : Buffer.isBuffer(options.blob)
        ? options.blob
        : Buffer.from(options.blob);
  runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<ToolArtifactDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("tool_artifacts")
        .values({
          run_id: runId,
          artifact_id: artifactId,
          kind,
          metadata_json: JSON.stringify(options.metadata ?? {}),
          blob,
          created_at: createdAt,
        })
        .onConflict((conflict) =>
          conflict.columns(["run_id", "artifact_id"]).doUpdateSet({
            kind,
            metadata_json: JSON.stringify(options.metadata ?? {}),
            blob,
            created_at: createdAt,
          }),
        ),
    );
  }, options);
  return {
    agentId,
    runId,
    artifactId,
    kind,
    metadata: options.metadata ?? {},
    size: blob?.byteLength ?? 0,
    createdAt,
  };
}

export function listSqliteToolArtifacts(
  options: SqliteToolArtifactStoreOptions,
): SqliteToolArtifact[] {
  const { agentId, runId } = normalizeScope(options);
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<ToolArtifactDatabase>(database.db);
  return executeSqliteQuerySync<ToolArtifactRow>(
    database.db,
    db
      .selectFrom("tool_artifacts")
      .select(["run_id", "artifact_id", "kind", "metadata_json", "blob", "created_at"])
      .where("run_id", "=", runId)
      .orderBy("created_at", "asc")
      .orderBy("artifact_id", "asc"),
  ).rows.map((row) => rowToArtifact(row, { agentId, runId }));
}

export function readSqliteToolArtifact(
  options: SqliteToolArtifactStoreOptions & { artifactId: string },
): SqliteToolArtifactExport | null {
  const { agentId, runId } = normalizeScope(options);
  const artifactId = normalizeArtifactId(options.artifactId);
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<ToolArtifactDatabase>(database.db);
  const row =
    executeSqliteQueryTakeFirstSync<ToolArtifactRow>(
      database.db,
      db
        .selectFrom("tool_artifacts")
        .select(["run_id", "artifact_id", "kind", "metadata_json", "blob", "created_at"])
        .where("run_id", "=", runId)
        .where("artifact_id", "=", artifactId),
    ) ?? null;
  return row ? rowToExport(row, { agentId, runId }) : null;
}

export function exportSqliteToolArtifacts(
  options: SqliteToolArtifactStoreOptions,
): SqliteToolArtifactExport[] {
  const { agentId, runId } = normalizeScope(options);
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<ToolArtifactDatabase>(database.db);
  return executeSqliteQuerySync<ToolArtifactRow>(
    database.db,
    db
      .selectFrom("tool_artifacts")
      .select(["run_id", "artifact_id", "kind", "metadata_json", "blob", "created_at"])
      .where("run_id", "=", runId)
      .orderBy("created_at", "asc")
      .orderBy("artifact_id", "asc"),
  ).rows.map((row) => rowToExport(row, { agentId, runId }));
}

export function deleteSqliteToolArtifacts(options: SqliteToolArtifactStoreOptions): number {
  const { runId } = normalizeScope(options);
  return runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<ToolArtifactDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      db.deleteFrom("tool_artifacts").where("run_id", "=", runId),
    );
    return Number(result.numAffectedRows ?? 0);
  }, options);
}

export class SqliteToolArtifactStore implements AgentToolArtifactStore {
  readonly #options: SqliteToolArtifactStoreOptions;

  constructor(options: SqliteToolArtifactStoreOptions) {
    this.#options = options;
  }

  write(options: AgentToolArtifactWriteOptions): AgentToolArtifact {
    return writeSqliteToolArtifact({
      ...this.#options,
      ...options,
    });
  }

  list(): AgentToolArtifact[] {
    return listSqliteToolArtifacts(this.#options);
  }

  read(artifactId: string): AgentToolArtifactExport | null {
    return readSqliteToolArtifact({
      ...this.#options,
      artifactId,
    });
  }

  export(): AgentToolArtifactExport[] {
    return exportSqliteToolArtifacts(this.#options);
  }

  deleteAll(): number {
    return deleteSqliteToolArtifacts(this.#options);
  }
}

export function createSqliteToolArtifactStore(
  options: SqliteToolArtifactStoreOptions,
): SqliteToolArtifactStore {
  return new SqliteToolArtifactStore(options);
}
