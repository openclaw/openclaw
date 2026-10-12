import type { DatabaseSync } from "node:sqlite";
import type { Insertable } from "kysely";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import { registerNodeSqliteDisposeCallback } from "../../infra/kysely-sync-cache-state.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import {
  getSqliteReadOperationRevision,
  type SqliteReadOperationRevision,
} from "../../infra/sqlite-schema-facts.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import type {
  AcpSessionsTable,
  AcpSessionRow,
  AcpSessionEntryBinding,
  AcpSessionReadInput,
} from "./session-meta-read.types.js";

type AcpSessionMetaDatabase = Pick<OpenClawStateKyselyDatabase, "acp_sessions">;

const MAX_RETAINED_ACP_SESSION_ROWS = 128;
const metadataRows = new WeakMap<
  DatabaseSync,
  SqliteReadOperationRevision & { rows: Map<string, AcpSessionRow | undefined> }
>();

export function getAcpSessionKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<AcpSessionMetaDatabase>(db);
}

export function selectAcpSessionRows(db: DatabaseSync): AcpSessionRow[] {
  return executeSqliteQuerySync(
    db,
    getAcpSessionKysely(db)
      .selectFrom("acp_sessions")
      .selectAll()
      .orderBy("last_activity_at", "desc")
      .orderBy("session_key", "asc"),
  ).rows;
}

export function selectAcpSessionRow(
  db: DatabaseSync,
  sessionKey: string,
): AcpSessionRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    getAcpSessionKysely(db)
      .selectFrom("acp_sessions")
      .selectAll()
      .where("session_key", "=", sessionKey),
  );
}

export function* selectAcpSessionRowsByKeys(
  db: DatabaseSync,
  keys: readonly string[],
  firstCohort?: readonly AcpSessionRow[],
) {
  const revision =
    keys.length <= MAX_RETAINED_ACP_SESSION_ROWS ? getSqliteReadOperationRevision(db) : undefined;
  let cached = metadataRows.get(db);
  if (revision) {
    if (!cached) {
      cached = { ...revision, rows: new Map() };
      metadataRows.set(db, cached);
      registerNodeSqliteDisposeCallback(db, () => metadataRows.delete(db));
    } else if (
      cached.schema !== revision.schema ||
      cached.writeRevision !== revision.writeRevision ||
      cached.mutationRevision !== revision.mutationRevision
    ) {
      Object.assign(cached, revision);
      cached.rows.clear();
    }
    const retainedRows = cached.rows;
    if (!firstCohort && keys.every((key) => retainedRows.has(key))) {
      const rows: AcpSessionRow[] = [];
      for (const key of new Set(keys)) {
        const row = retainedRows.get(key);
        if (row) {
          rows.push({ ...row });
        }
      }
      yield* rows;
      return;
    }
  }
  // Read the whole cohort on a miss: mixing retained and new rows would give
  // callers a different view if another writer commits during this request.
  for (let index = 0; index < keys.length; index += 500) {
    const cohort = keys.slice(index, index + 500);
    const rows =
      index === 0 && firstCohort
        ? firstCohort
        : executeSqliteQuerySync(
            db,
            getAcpSessionKysely(db)
              .selectFrom("acp_sessions")
              .selectAll()
              .where("session_key", "in", sqliteStringSet(cohort)),
          ).rows;
    if (revision && cached && getSqliteReadOperationRevision(db) === revision) {
      if (cached.rows.size + cohort.length > MAX_RETAINED_ACP_SESSION_ROWS) {
        cached.rows.clear();
      }
      for (const key of cohort) {
        cached.rows.set(key, undefined);
      }
      for (const row of rows) {
        cached.rows.set(row.session_key, { ...row });
      }
    }
    yield* rows;
  }
}

const ACP_DATABASE_KEY_PREFIX = "@acp:v1:";

export function buildAcpDatabaseSessionKey(storeSessionKey: string, agentId?: string): string {
  const normalizedKey = storeSessionKey.trim();
  const identity = [agentId ? normalizeAgentId(agentId) : null, normalizedKey];
  return `${ACP_DATABASE_KEY_PREFIX}${Buffer.from(JSON.stringify(identity), "utf8").toString("base64url")}`;
}

export function parseAcpDatabaseSessionKey(sessionKey: string):
  | {
      agentId?: string;
      storeSessionKey: string;
    }
  | undefined {
  if (!sessionKey.startsWith(ACP_DATABASE_KEY_PREFIX)) {
    return undefined;
  }
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(sessionKey.slice(ACP_DATABASE_KEY_PREFIX.length), "base64url").toString("utf8"),
    );
    if (
      Array.isArray(decoded) &&
      decoded.length === 2 &&
      (decoded[0] === null || typeof decoded[0] === "string") &&
      typeof decoded[1] === "string"
    ) {
      const identity = {
        ...(decoded[0] ? { agentId: normalizeAgentId(decoded[0]) } : {}),
        storeSessionKey: decoded[1],
      };
      return buildAcpDatabaseSessionKey(identity.storeSessionKey, identity.agentId) === sessionKey
        ? identity
        : undefined;
    }
  } catch {
    // Doctor owns malformed historical keys; runtime only accepts canonical identities.
  }
  return undefined;
}

export function acpSessionRowMatchesEntry(
  row: Pick<AcpSessionRow, "session_id" | "updated_at">,
  entry: AcpSessionEntryBinding | undefined,
): boolean {
  return (
    row.session_id == null ||
    row.session_id === entry?.lifecycleRevision ||
    (row.session_id === entry?.sessionId &&
      (entry?.sessionStartedAt === undefined || row.updated_at >= entry.sessionStartedAt))
  );
}

export function selectAcpSessionRowForStoreEntry(
  db: DatabaseSync,
  storeSessionKey: string,
  agentId?: string,
  entry?: AcpSessionEntryBinding,
): AcpSessionRow | undefined {
  const key = normalizeStoreSessionKey(storeSessionKey);
  return selectAcpSessionRowForRead(db, {
    keys: [buildAcpDatabaseSessionKey(key, agentId ?? parseAgentSessionKey(key)?.agentId)],
    entry,
  });
}

export function selectAcpSessionRowForRead(
  db: DatabaseSync,
  { keys, entry }: AcpSessionReadInput,
): AcpSessionRow | undefined {
  for (const key of keys) {
    const row = selectAcpSessionRow(db, key);
    if (row && (!entry || acpSessionRowMatchesEntry(row, entry))) {
      return row;
    }
  }
  return undefined;
}

export function resolveReadableAcpSessionRow(params: {
  row: AcpSessionRow | undefined;
  entry: AcpSessionEntryBinding | undefined;
}): AcpSessionRow | undefined {
  const { row, entry } = params;
  return row && acpSessionRowMatchesEntry(row, entry) ? row : undefined;
}

export function upsertAcpSessionMetaRow(db: DatabaseSync, row: Insertable<AcpSessionsTable>) {
  return executeSqliteQueryTakeFirstSync(
    db,
    getAcpSessionKysely(db)
      .insertInto("acp_sessions")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("session_key").doUpdateSet({
          session_id: (eb) => eb.ref("excluded.session_id"),
          backend: (eb) => eb.ref("excluded.backend"),
          agent: (eb) => eb.ref("excluded.agent"),
          runtime_session_name: (eb) => eb.ref("excluded.runtime_session_name"),
          identity_json: (eb) => eb.ref("excluded.identity_json"),
          mode: (eb) => eb.ref("excluded.mode"),
          runtime_options_json: (eb) => eb.ref("excluded.runtime_options_json"),
          cwd: (eb) => eb.ref("excluded.cwd"),
          state: (eb) => eb.ref("excluded.state"),
          last_activity_at: (eb) => eb.ref("excluded.last_activity_at"),
          last_error: (eb) => eb.ref("excluded.last_error"),
          updated_at: (eb) => eb.ref("excluded.updated_at"),
        }),
      )
      .returningAll(),
  );
}
