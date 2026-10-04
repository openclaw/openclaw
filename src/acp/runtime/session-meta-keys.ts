import type { DatabaseSync } from "node:sqlite";
import type { Insertable } from "kysely";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import type {
  AcpSessionsTable,
  AcpSessionRow,
  AcpSessionEntryBinding,
  AcpSessionReadInput,
} from "./session-meta-read.types.js";

type AcpSessionMetaDatabase = Pick<OpenClawStateKyselyDatabase, "acp_sessions">;

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
  row: AcpSessionRow,
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

export function upsertAcpSessionMetaRow(db: DatabaseSync, row: Insertable<AcpSessionsTable>): void {
  executeSqliteQuerySync(
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
      ),
  );
}
