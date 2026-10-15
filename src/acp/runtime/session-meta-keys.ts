import type { Insertable } from "kysely";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import { registerNodeSqliteDisposeCallback } from "../../infra/kysely-sync-cache-state.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { sqlPublicationAnchor } from "../../infra/sql-connection.js";
import {
  getOrLoadSqliteDatabaseAdmissionForPath,
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "../../infra/sqlite-database-admission.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
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
type AcpMetadataReceipt = Map<string, AcpSessionRow | undefined>;
const metadataReceipt: SqliteDatabaseAdmissionKey<AcpMetadataReceipt> = {
  name: "acp.metadata",
  schemaDependent: true,
  read(value) {
    // SAFETY: Committed postimages come only from the paired, typed ACP writer.
    return value instanceof Map ? (value as AcpMetadataReceipt) : undefined;
  },
};
const pendingMetadataChanges = new WeakMap<EngineConnection, AcpMetadataReceipt>();
const localMetadataChanges = new WeakMap<EngineConnection, AcpMetadataReceipt>();
const metadataRows = new WeakMap<
  EngineConnection,
  {
    schema: SqliteReadOperationRevision["schema"];
    receipt: AcpMetadataReceipt | undefined;
    rows: Map<string, AcpSessionRow | undefined>;
  }
>();

function publishAcpMetadataRows(
  db: EngineConnection,
  rows: readonly (readonly [string, AcpSessionRow | undefined])[],
) {
  if (rows.length === 0) {
    return;
  }
  const anchor = sqlPublicationAnchor(db);
  const previous = pendingMetadataChanges.get(anchor);
  const receipt = new Map(previous ?? getSqliteDatabaseAdmission(db, metadataReceipt));
  for (const [key, row] of rows) {
    receipt.delete(key);
    receipt.set(key, row);
  }
  while (receipt.size > MAX_RETAINED_ACP_SESSION_ROWS) {
    receipt.delete(receipt.keys().next().value!);
  }
  const commit = () => {
    pendingMetadataChanges.delete(anchor);
    localMetadataChanges.set(anchor, receipt);
  };
  const staged = stageSqliteTransactionState(anchor, {
    stage: () => pendingMetadataChanges.set(anchor, receipt),
    commit,
    rollback: () => {
      if (previous) {
        pendingMetadataChanges.set(anchor, previous);
      } else {
        pendingMetadataChanges.delete(anchor);
      }
    },
  });
  if (!staged) {
    commit();
  }
  publishSqliteDatabaseAdmission(db, metadataReceipt, receipt);
}

/** Host readers consume committed postimages; unknown keys retain the worker read path. */
export function readPublishedAcpSessionRows(
  databasePath: string,
  entries: readonly AcpSessionReadInput[],
): Array<AcpSessionRow | null> | undefined {
  const rows = getOrLoadSqliteDatabaseAdmissionForPath(
    databasePath,
    metadataReceipt,
    () => undefined,
  );
  if (!rows || entries.some(({ keys }) => keys.some((key) => !rows.has(key)))) {
    return undefined;
  }
  return entries.map(({ keys, entry }) => {
    const row = keys
      .map((key) => rows.get(key))
      .find((candidate) => candidate && acpSessionRowMatchesEntry(candidate, entry));
    return row ? { ...row } : null;
  });
}

export function getAcpSessionKysely(db: EngineConnection) {
  return getNodeSqliteKysely<AcpSessionMetaDatabase>(db);
}

export function selectAcpSessionRows(db: EngineConnection): AcpSessionRow[] {
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
  db: EngineConnection,
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
  db: EngineConnection,
  keys: readonly string[],
  firstCohort?: readonly AcpSessionRow[],
) {
  const revision =
    keys.length <= MAX_RETAINED_ACP_SESSION_ROWS ? getSqliteReadOperationRevision(db) : undefined;
  let cached = metadataRows.get(db);
  if (revision) {
    const published = getSqliteDatabaseAdmission(db, metadataReceipt);
    const receipt = published ?? localMetadataChanges.get(sqlPublicationAnchor(db));
    if (!cached) {
      cached = { schema: revision.schema, receipt, rows: new Map(published) };
      metadataRows.set(db, cached);
      registerNodeSqliteDisposeCallback(sqlPublicationAnchor(db), () => metadataRows.delete(db));
    } else if (cached.schema !== revision.schema || cached.receipt !== receipt) {
      cached.schema = revision.schema;
      cached.receipt = receipt;
      // Receipts contain complete committed postimages for their bounded cohort.
      // Uncovered reads remain local and never overwrite a newer writer receipt.
      // The local fallback invalidates reads but cannot certify schema-dependent rows.
      cached.rows = new Map(published);
    }
    const retainedRows = cached.rows;
    if (keys.every((key) => retainedRows.has(key))) {
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
  for (let index = 0; index < keys.length; index += 500) {
    const cohort = keys.slice(index, index + 500);
    const retained = revision && cached ? cached.rows : undefined;
    const missing = retained ? cohort.filter((key) => !retained.has(key)) : cohort;
    const selected =
      index === 0 && firstCohort
        ? firstCohort.filter((row) => missing.includes(row.session_key))
        : executeSqliteQuerySync(
            db,
            getAcpSessionKysely(db)
              .selectFrom("acp_sessions")
              .selectAll()
              .where("session_key", "in", sqliteStringSet(missing)),
          ).rows;
    const rows = retained
      ? [
          ...cohort.flatMap((key) => {
            const row = retained.get(key);
            return row ? [{ ...row }] : [];
          }),
          ...selected,
        ]
      : selected;
    if (revision && cached) {
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
  db: EngineConnection,
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
  db: EngineConnection,
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

export function upsertAcpSessionMetaRow(db: EngineConnection, row: Insertable<AcpSessionsTable>) {
  const written = executeSqliteQueryTakeFirstSync(
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
          resume_agent_session_id: (eb) => eb.ref("excluded.resume_agent_session_id"),
          resume_acpx_session_id: (eb) => eb.ref("excluded.resume_acpx_session_id"),
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
  if (written) {
    publishAcpMetadataRows(db, [[written.session_key, written]]);
  }
  return written;
}

export function deleteAcpSessionMetaRows(db: EngineConnection, keys: readonly string[]): void {
  if (keys.length === 0) {
    return;
  }
  const deleted = executeSqliteQuerySync(
    db,
    getAcpSessionKysely(db)
      .deleteFrom("acp_sessions")
      .where("session_key", "in", sqliteStringSet(keys))
      .returning("session_key"),
  ).rows;
  publishAcpMetadataRows(
    db,
    deleted.map((row) => [row.session_key, undefined] as const),
  );
}
