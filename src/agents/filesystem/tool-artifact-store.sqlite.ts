import { randomUUID } from "node:crypto";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import type {
  AgentToolArtifact,
  AgentToolArtifactExport,
  AgentToolArtifactStore,
  AgentToolArtifactWriteOptions,
} from "./agent-filesystem.js";

export type SqliteToolArtifact = AgentToolArtifact;
export type SqliteToolArtifactExport = AgentToolArtifactExport;

export type SqliteToolArtifactStoreOptions = OpenClawStateDatabaseOptions & {
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

type ToolArtifactRow = {
  agent_id: string;
  run_id: string;
  artifact_id: string;
  kind: string;
  metadata_json: string;
  blob: Buffer | null;
  created_at: number | bigint;
};

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

function rowToArtifact(row: ToolArtifactRow): SqliteToolArtifact {
  return {
    agentId: row.agent_id,
    runId: row.run_id,
    artifactId: row.artifact_id,
    kind: row.kind,
    metadata: parseMetadata(row.metadata_json),
    size: row.blob?.byteLength ?? 0,
    createdAt: typeof row.created_at === "bigint" ? Number(row.created_at) : row.created_at,
  };
}

function rowToExport(row: ToolArtifactRow): SqliteToolArtifactExport {
  return {
    ...rowToArtifact(row),
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
  runOpenClawStateWriteTransaction((database) => {
    database.db
      .prepare(
        `
          INSERT INTO tool_artifacts (
            agent_id,
            run_id,
            artifact_id,
            kind,
            metadata_json,
            blob,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(agent_id, run_id, artifact_id) DO UPDATE SET
            kind = excluded.kind,
            metadata_json = excluded.metadata_json,
            blob = excluded.blob,
            created_at = excluded.created_at
        `,
      )
      .run(
        agentId,
        runId,
        artifactId,
        kind,
        JSON.stringify(options.metadata ?? {}),
        blob,
        createdAt,
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
  const database = openOpenClawStateDatabase(options);
  return (
    database.db
      .prepare(
        `
        SELECT agent_id, run_id, artifact_id, kind, metadata_json, blob, created_at
        FROM tool_artifacts
        WHERE agent_id = ? AND run_id = ?
        ORDER BY created_at ASC, artifact_id ASC
      `,
      )
      .all(agentId, runId) as ToolArtifactRow[]
  ).map(rowToArtifact);
}

export function readSqliteToolArtifact(
  options: SqliteToolArtifactStoreOptions & { artifactId: string },
): SqliteToolArtifactExport | null {
  const { agentId, runId } = normalizeScope(options);
  const artifactId = normalizeArtifactId(options.artifactId);
  const database = openOpenClawStateDatabase(options);
  const row =
    (database.db
      .prepare(
        `
          SELECT agent_id, run_id, artifact_id, kind, metadata_json, blob, created_at
          FROM tool_artifacts
          WHERE agent_id = ? AND run_id = ? AND artifact_id = ?
        `,
      )
      .get(agentId, runId, artifactId) as ToolArtifactRow | undefined) ?? null;
  return row ? rowToExport(row) : null;
}

export function exportSqliteToolArtifacts(
  options: SqliteToolArtifactStoreOptions,
): SqliteToolArtifactExport[] {
  const { agentId, runId } = normalizeScope(options);
  const database = openOpenClawStateDatabase(options);
  return (
    database.db
      .prepare(
        `
        SELECT agent_id, run_id, artifact_id, kind, metadata_json, blob, created_at
        FROM tool_artifacts
        WHERE agent_id = ? AND run_id = ?
        ORDER BY created_at ASC, artifact_id ASC
      `,
      )
      .all(agentId, runId) as ToolArtifactRow[]
  ).map(rowToExport);
}

export function deleteSqliteToolArtifacts(options: SqliteToolArtifactStoreOptions): number {
  const { agentId, runId } = normalizeScope(options);
  return runOpenClawStateWriteTransaction((database) => {
    const result = database.db
      .prepare("DELETE FROM tool_artifacts WHERE agent_id = ? AND run_id = ?")
      .run(agentId, runId);
    return Number(result.changes ?? 0);
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
