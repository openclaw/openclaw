import type { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import fs from "node:fs";
import { createRequire } from "node:module";
import { resolveDoltDbPath } from "./dolt-db-path.js";

export type DoltRecordLevel = "turn" | "leaf" | "bindle";

type LoggerLike = {
  warn?: (message: string) => void;
  debug?: (message: string) => void;
};

type ToolContextLike = {
  agentId?: string;
  sessionKey?: string;
};

type SqliteVecModule = {
  load: (db: DatabaseSync) => void;
};

type SqliteModule = {
  DatabaseSync: new (
    filename: string,
    options?: {
      readOnly?: boolean;
      allowExtension?: boolean;
    },
  ) => DatabaseSync;
};

type SqliteRecordRow = {
  pointer: string;
  session_id: string;
  session_key: string | null;
  level: string;
  event_ts_ms: number;
  token_count: number;
  token_count_method: string;
  payload_json: string | null;
  finalized_at_reset: number;
  created_at_ms: number;
  updated_at_ms: number;
};

type SqliteLineageRow = {
  parent_pointer: string;
  child_pointer: string;
  child_index: number;
  child_level: string;
  created_at_ms: number;
};

type SqliteLaneRow = {
  session_id: string;
  session_key: string | null;
  level: string;
  pointer: string;
  is_active: number;
  last_event_ts_ms: number;
  updated_at_ms: number;
};

type SqliteSearchRow = {
  pointer: string;
  session_id: string;
  event_ts_ms: number;
  payload_json: string | null;
};

export type DoltQueryAvailability = {
  available: boolean;
  dbPath: string;
  reason?: "missing_db" | "open_failed";
  detail?: string;
};

export type DoltQueryRecord = {
  pointer: string;
  sessionId: string;
  sessionKey: string | null;
  level: DoltRecordLevel;
  eventTsMs: number;
  tokenCount: number;
  tokenCountMethod: string;
  payload: unknown;
  payloadJson: string | null;
  finalizedAtReset: boolean;
  createdAtMs: number;
  updatedAtMs: number;
};

export type DoltLineageEdge = {
  parentPointer: string;
  childPointer: string;
  childIndex: number;
  childLevel: DoltRecordLevel;
  createdAtMs: number;
};

export type DoltActiveLaneEntry = {
  sessionId: string;
  sessionKey: string | null;
  level: DoltRecordLevel;
  pointer: string;
  isActive: boolean;
  lastEventTsMs: number;
  updatedAtMs: number;
};

export type DoltGhostSummary = {
  bindlePointer: string;
  summaryText: string | null;
  tokenCount: number | null;
  row: Record<string, unknown>;
};

export type SearchTurnPayloadParams = {
  sessionId: string;
  pattern: string;
  parentPointer?: string;
  limit?: number;
  offset?: number;
};

export type SearchTurnPayloadMatch = {
  pointer: string;
  sessionId: string;
  eventTsMs: number;
  role: string | null;
  content: string;
  payloadJson: string | null;
};

export type DoltReadOnlyQueryHelpers = {
  getAvailability: () => DoltQueryAvailability;
  getRecord: (pointer: string) => DoltQueryRecord | null;
  listDirectParents: (childPointer: string) => DoltLineageEdge[];
  listDirectChildren: (parentPointer: string) => DoltLineageEdge[];
  listDirectChildRecords: (parentPointer: string) => DoltQueryRecord[];
  listActiveLane: (
    sessionId: string,
    level: DoltRecordLevel,
    activeOnly?: boolean,
  ) => DoltActiveLaneEntry[];
  getGhostSummary: (bindlePointer: string) => DoltGhostSummary | null;
  searchTurnPayloads: (params: SearchTurnPayloadParams) => SearchTurnPayloadMatch[];
};

export type DoltReadOnlyQueryRuntime = {
  warmup: (agentId?: string) => void;
  forContext: (ctx: ToolContextLike) => DoltReadOnlyQueryHelpers;
  dispose: () => void;
};

/**
 * Create a shared read-only Dolt query runtime for tool registration.
 */
export function createDoltReadOnlyQueryRuntime(params: {
  config?: OpenClawConfig;
  resolveStateDir: () => string;
  logger?: LoggerLike;
}): DoltReadOnlyQueryRuntime {
  const require = createRequire(import.meta.url);
  const dbByPath = new Map<string, DatabaseSync>();
  const openFailures = new Map<string, string>();
  const warnedFailures = new Set<string>();
  const warnedVecPaths = new Set<string>();

  const resolvePathForAgent = (agentId?: string): string =>
    resolveDoltDbPath({
      config: params.config,
      resolveStateDir: params.resolveStateDir,
      agentId,
    });

  const ensureOpen = (dbPath: string): DatabaseSync | null => {
    const cached = dbByPath.get(dbPath);
    if (cached) {
      return cached;
    }
    if (!fs.existsSync(dbPath)) {
      openFailures.delete(dbPath);
      return null;
    }

    try {
      const sqlite = requireNodeSqlite(require);
      const db = new sqlite.DatabaseSync(dbPath, {
        readOnly: true,
        allowExtension: true,
      });
      db.exec("PRAGMA busy_timeout = 50");
      loadSqliteVecIfAvailable({
        db,
        dbPath,
        require,
        logger: params.logger,
        warnedVecPaths,
      });
      dbByPath.set(dbPath, db);
      openFailures.delete(dbPath);
      warnedFailures.delete(dbPath);
      return db;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      openFailures.set(dbPath, message);
      if (!warnedFailures.has(dbPath)) {
        warnedFailures.add(dbPath);
        params.logger?.warn?.(
          `dolt-context-tools: failed to open read-only dolt db at ${dbPath}: ${message}`,
        );
      }
      return null;
    }
  };

  const availabilityForPath = (dbPath: string): DoltQueryAvailability => {
    if (dbByPath.has(dbPath)) {
      return {
        available: true,
        dbPath,
      };
    }
    if (!fs.existsSync(dbPath)) {
      return {
        available: false,
        dbPath,
        reason: "missing_db",
      };
    }
    const db = ensureOpen(dbPath);
    if (db) {
      return {
        available: true,
        dbPath,
      };
    }
    return {
      available: false,
      dbPath,
      reason: "open_failed",
      detail: openFailures.get(dbPath),
    };
  };

  const forAgent = (agentId?: string): DoltReadOnlyQueryHelpers => {
    const dbPath = resolvePathForAgent(agentId);

    return {
      getAvailability: () => availabilityForPath(dbPath),

      getRecord: (pointer) => {
        const normalizedPointer = normalizeOptionalString(pointer);
        if (!normalizedPointer) {
          return null;
        }
        return readWithFallback({
          db: ensureOpen(dbPath),
          fallback: null,
          logger: params.logger,
          scope: "getRecord",
          read: (db) => {
            const row = db
              .prepare(
                `
                  SELECT
                    pointer,
                    session_id,
                    session_key,
                    level,
                    event_ts_ms,
                    token_count,
                    token_count_method,
                    payload_json,
                    finalized_at_reset,
                    created_at_ms,
                    updated_at_ms
                  FROM dolt_records
                  WHERE pointer = ?
                  LIMIT 1
                `,
              )
              .get(normalizedPointer) as SqliteRecordRow | undefined;
            return row ? mapRecordRow(row) : null;
          },
        });
      },

      listDirectParents: (childPointer) => {
        const normalizedChildPointer = normalizeOptionalString(childPointer);
        if (!normalizedChildPointer) {
          return [];
        }
        return readWithFallback({
          db: ensureOpen(dbPath),
          fallback: [],
          logger: params.logger,
          scope: "listDirectParents",
          read: (db) => {
            const rows = db
              .prepare(
                `
                  SELECT parent_pointer, child_pointer, child_index, child_level, created_at_ms
                  FROM dolt_lineage
                  WHERE child_pointer = ?
                  ORDER BY parent_pointer ASC
                `,
              )
              .all(normalizedChildPointer) as SqliteLineageRow[];
            return rows.map((row) => mapLineageRow(row));
          },
        });
      },

      listDirectChildren: (parentPointer) => {
        const normalizedParentPointer = normalizeOptionalString(parentPointer);
        if (!normalizedParentPointer) {
          return [];
        }
        return readWithFallback({
          db: ensureOpen(dbPath),
          fallback: [],
          logger: params.logger,
          scope: "listDirectChildren",
          read: (db) => {
            const rows = db
              .prepare(
                `
                  SELECT parent_pointer, child_pointer, child_index, child_level, created_at_ms
                  FROM dolt_lineage
                  WHERE parent_pointer = ?
                  ORDER BY child_index ASC, child_pointer ASC
                `,
              )
              .all(normalizedParentPointer) as SqliteLineageRow[];
            return rows.map((row) => mapLineageRow(row));
          },
        });
      },

      listDirectChildRecords: (parentPointer) => {
        const normalizedParentPointer = normalizeOptionalString(parentPointer);
        if (!normalizedParentPointer) {
          return [];
        }
        return readWithFallback({
          db: ensureOpen(dbPath),
          fallback: [],
          logger: params.logger,
          scope: "listDirectChildRecords",
          read: (db) => {
            const rows = db
              .prepare(
                `
                  SELECT
                    r.pointer,
                    r.session_id,
                    r.session_key,
                    r.level,
                    r.event_ts_ms,
                    r.token_count,
                    r.token_count_method,
                    r.payload_json,
                    r.finalized_at_reset,
                    r.created_at_ms,
                    r.updated_at_ms
                  FROM dolt_lineage l
                  JOIN dolt_records r ON r.pointer = l.child_pointer
                  WHERE l.parent_pointer = ?
                  ORDER BY l.child_index ASC, l.child_pointer ASC
                `,
              )
              .all(normalizedParentPointer) as SqliteRecordRow[];
            return rows.map((row) => mapRecordRow(row));
          },
        });
      },

      listActiveLane: (sessionId, level, activeOnly = true) => {
        const normalizedSessionId = normalizeOptionalString(sessionId);
        if (!normalizedSessionId) {
          return [];
        }
        return readWithFallback({
          db: ensureOpen(dbPath),
          fallback: [],
          logger: params.logger,
          scope: "listActiveLane",
          read: (db) => {
            const rows = db
              .prepare(
                `
                  SELECT
                    session_id,
                    session_key,
                    level,
                    pointer,
                    is_active,
                    last_event_ts_ms,
                    updated_at_ms
                  FROM dolt_active_lane
                  WHERE session_id = ? AND level = ? AND (? = 0 OR is_active = 1)
                  ORDER BY last_event_ts_ms DESC, pointer DESC
                `,
              )
              .all(normalizedSessionId, level, activeOnly ? 1 : 0) as SqliteLaneRow[];
            return rows.map((row) => mapLaneRow(row));
          },
        });
      },

      getGhostSummary: (bindlePointer) => {
        const normalizedBindlePointer = normalizeOptionalString(bindlePointer);
        if (!normalizedBindlePointer) {
          return null;
        }
        return readWithFallback({
          db: ensureOpen(dbPath),
          fallback: null,
          logger: params.logger,
          scope: "getGhostSummary",
          read: (db) => {
            const row = db
              .prepare(
                `
                  SELECT *
                  FROM dolt_ghost_summaries
                  WHERE bindle_pointer = ?
                  LIMIT 1
                `,
              )
              .get(normalizedBindlePointer) as Record<string, unknown> | undefined;
            if (!row) {
              return null;
            }
            return {
              bindlePointer: asString(row.bindle_pointer) ?? normalizedBindlePointer,
              summaryText: asString(row.summary_text) ?? asString(row.summary) ?? null,
              tokenCount: asNumber(row.token_count),
              row,
            } satisfies DoltGhostSummary;
          },
        });
      },

      searchTurnPayloads: (searchParams) => {
        const normalizedSessionId = normalizeOptionalString(searchParams.sessionId);
        const normalizedPattern = normalizeOptionalString(searchParams.pattern);
        if (!normalizedSessionId || !normalizedPattern) {
          return [];
        }
        const regex = new RegExp(normalizedPattern, "iu");
        const limit = normalizePositiveInt(searchParams.limit, 50);
        const offset = normalizeOffset(searchParams.offset);

        return readWithFallback({
          db: ensureOpen(dbPath),
          fallback: [],
          logger: params.logger,
          scope: "searchTurnPayloads",
          read: (db) => {
            const rows = listSearchCandidateRows({
              db,
              sessionId: normalizedSessionId,
              parentPointer: normalizeOptionalString(searchParams.parentPointer),
            });

            const matched = rows.flatMap((row) => {
              const payload = parsePayload(row.payload_json);
              const extracted = extractTurnText(payload);
              const searchable = [extracted.role ?? "", extracted.content, row.payload_json ?? ""]
                .filter(Boolean)
                .join("\n");
              if (!regex.test(searchable)) {
                return [];
              }
              return [
                {
                  pointer: row.pointer,
                  sessionId: row.session_id,
                  eventTsMs: row.event_ts_ms,
                  role: extracted.role,
                  content: extracted.content,
                  payloadJson: row.payload_json,
                } satisfies SearchTurnPayloadMatch,
              ];
            });

            return matched.slice(offset, offset + limit);
          },
        });
      },
    };
  };

  return {
    warmup: (agentId) => {
      ensureOpen(resolvePathForAgent(agentId));
    },
    forContext: (ctx) => {
      const agentId = resolveAgentIdFromContext(ctx);
      return forAgent(agentId);
    },
    dispose: () => {
      for (const db of dbByPath.values()) {
        try {
          db.close();
        } catch {
          // Ignore close errors during shutdown.
        }
      }
      dbByPath.clear();
      openFailures.clear();
      warnedFailures.clear();
      warnedVecPaths.clear();
    },
  };
}

function requireNodeSqlite(require: NodeRequire): SqliteModule {
  return require("node:sqlite") as SqliteModule;
}

function loadSqliteVecIfAvailable(params: {
  db: DatabaseSync;
  dbPath: string;
  require: NodeRequire;
  logger?: LoggerLike;
  warnedVecPaths: Set<string>;
}): void {
  try {
    const sqliteVec = params.require("sqlite-vec") as SqliteVecModule;
    params.db.enableLoadExtension(true);
    sqliteVec.load(params.db);
  } catch (error) {
    if (params.warnedVecPaths.has(params.dbPath)) {
      return;
    }
    params.warnedVecPaths.add(params.dbPath);
    const message = error instanceof Error ? error.message : String(error);
    params.logger?.warn?.(
      `dolt-context-tools: sqlite-vec unavailable for ${params.dbPath}; continuing without vectors (${message})`,
    );
  }
}

function listSearchCandidateRows(params: {
  db: DatabaseSync;
  sessionId: string;
  parentPointer: string | null;
}): SqliteSearchRow[] {
  if (!params.parentPointer) {
    return params.db
      .prepare(
        `
          SELECT pointer, session_id, event_ts_ms, payload_json
          FROM dolt_records
          WHERE session_id = ? AND level = 'turn'
          ORDER BY event_ts_ms ASC, pointer ASC
        `,
      )
      .all(params.sessionId) as SqliteSearchRow[];
  }

  return params.db
    .prepare(
      `
        SELECT r.pointer, r.session_id, r.event_ts_ms, r.payload_json
        FROM dolt_records r
        WHERE r.session_id = ?
          AND r.level = 'turn'
          AND r.pointer IN (
            SELECT child_pointer
            FROM dolt_lineage
            WHERE parent_pointer = ?
            UNION
            SELECT l2.child_pointer
            FROM dolt_lineage l1
            JOIN dolt_lineage l2 ON l2.parent_pointer = l1.child_pointer
            WHERE l1.parent_pointer = ?
          )
        ORDER BY r.event_ts_ms ASC, r.pointer ASC
      `,
    )
    .all(params.sessionId, params.parentPointer, params.parentPointer) as SqliteSearchRow[];
}

function readWithFallback<T>(params: {
  db: DatabaseSync | null;
  fallback: T;
  logger?: LoggerLike;
  scope: string;
  read: (db: DatabaseSync) => T;
}): T {
  if (!params.db) {
    return params.fallback;
  }
  try {
    return params.read(params.db);
  } catch (error) {
    if (isSchemaGapError(error)) {
      return params.fallback;
    }
    const message = error instanceof Error ? error.message : String(error);
    params.logger?.warn?.(`dolt-context-tools: ${params.scope} query failed: ${message}`);
    return params.fallback;
  }
}

function resolveAgentIdFromContext(ctx: ToolContextLike): string | undefined {
  const explicit = normalizeOptionalString(ctx.agentId);
  if (explicit) {
    return explicit;
  }
  const sessionKey = normalizeOptionalString(ctx.sessionKey);
  if (!sessionKey) {
    return undefined;
  }
  const match = /^agent:([^:]+):/i.exec(sessionKey);
  return match?.[1] ? match[1] : undefined;
}

function isSchemaGapError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table/i.test(message) || /no such column/i.test(message);
}

function mapRecordRow(row: SqliteRecordRow): DoltQueryRecord {
  return {
    pointer: row.pointer,
    sessionId: row.session_id,
    sessionKey: row.session_key,
    level: normalizeRecordLevel(row.level),
    eventTsMs: row.event_ts_ms,
    tokenCount: row.token_count,
    tokenCountMethod: row.token_count_method,
    payload: parsePayload(row.payload_json),
    payloadJson: row.payload_json,
    finalizedAtReset: row.finalized_at_reset === 1,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function mapLineageRow(row: SqliteLineageRow): DoltLineageEdge {
  return {
    parentPointer: row.parent_pointer,
    childPointer: row.child_pointer,
    childIndex: row.child_index,
    childLevel: normalizeRecordLevel(row.child_level),
    createdAtMs: row.created_at_ms,
  };
}

function mapLaneRow(row: SqliteLaneRow): DoltActiveLaneEntry {
  return {
    sessionId: row.session_id,
    sessionKey: row.session_key,
    level: normalizeRecordLevel(row.level),
    pointer: row.pointer,
    isActive: row.is_active === 1,
    lastEventTsMs: row.last_event_ts_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function normalizeRecordLevel(level: string): DoltRecordLevel {
  if (level === "turn" || level === "leaf" || level === "bindle") {
    return level;
  }
  return "turn";
}

function parsePayload(payloadJson: string | null): unknown {
  if (!payloadJson) {
    return null;
  }
  try {
    return JSON.parse(payloadJson) as unknown;
  } catch {
    return payloadJson;
  }
}

function extractTurnText(payload: unknown): { role: string | null; content: string } {
  if (typeof payload === "string") {
    return { role: null, content: payload };
  }

  const record = asRecord(payload);
  if (!record) {
    return { role: null, content: "" };
  }

  const role = asString(record.role) ?? null;
  const contentValue = record.content;

  if (typeof contentValue === "string") {
    return { role, content: contentValue };
  }

  if (Array.isArray(contentValue)) {
    const parts = contentValue
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        const block = asRecord(entry);
        if (!block) {
          return "";
        }
        return asString(block.text) ?? asString(block.content) ?? "";
      })
      .filter((part) => part.length > 0);

    return { role, content: parts.join("\n") };
  }

  return { role, content: "" };
}

function normalizeOptionalString(value: string | undefined | null): string | null {
  const normalized = (value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeOffset(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
