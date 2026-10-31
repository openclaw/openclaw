import { sql, type Expression, type SqlBool } from "kysely";
import {
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { requiredString, type WorkboardCardDatabase } from "./sqlite-store-records.js";
import type { WorkboardSqlConnection } from "./sqlite-store-schema.js";

function readIds(
  db: WorkboardSqlConnection,
  predicate: Expression<SqlBool>,
  boardId?: string,
): string[] {
  let query = getNodeSqliteKysely<WorkboardCardDatabase>(db)
    .selectFrom("workboard_cards")
    .select("id")
    .where(sql<SqlBool>`(${predicate})`);
  if (boardId !== undefined) {
    query = query.where("board_id", "=", boardId);
  }
  return Array.from(iterateSqliteQuerySync(db, query)).map((row) => requiredString(row, "id"));
}

// Reconciliation candidates stay archived-excluded, while terminal worktree
// cleanup keeps its own archived-safe obligation (path and sourcePath present
// only until cleanup discharges it).
export function readLifecycleCandidateIds(db: WorkboardSqlConnection, boardId?: string): string[] {
  const lifecycle = sql<SqlBool>`archived_at IS NULL AND (
    status = 'running' OR execution_status = 'running'
    OR (status NOT IN ('review', 'blocked', 'done') AND (
      COALESCE(session_key, '') != '' OR COALESCE(run_id, '') != ''
      OR COALESCE(execution_id, '') != ''
    ))
    OR EXISTS (SELECT 1 FROM workboard_card_attempts AS attempt
      WHERE attempt.card_id = workboard_cards.id AND attempt.status = 'running')
    OR COALESCE(automation_json, '') LIKE '%"phase":"prepared"%'
    OR claim_json IS NOT NULL
    OR stale_json IS NOT NULL
  )`;
  const cleanup = sql<SqlBool>`COALESCE(automation_json, '') LIKE '%"kind":"worktree"%'
    AND COALESCE(automation_json, '') LIKE '%"sourcePath"%'`;
  return readIds(db, sql<SqlBool>`(${lifecycle}) OR (${cleanup})`, boardId);
}

// Session lifecycle events also match a bare subagent key by suffix, including
// execution-only links and recorded attempt/event links. Provisional workboard
// run ids stay eligible until the authoritative matcher decides.
export function readLifecycleEventCandidateIds(
  db: WorkboardSqlConnection,
  source: { sessionKey?: string; runId?: string; boardId?: string },
): string[] {
  const clauses: Expression<SqlBool>[] = [];
  if (source.sessionKey) {
    const key = source.sessionKey;
    clauses.push(
      sql<SqlBool>`session_key = ${key}`,
      sql<SqlBool>`execution_session_key = ${key}`,
      sql<SqlBool>`(session_key LIKE 'subagent:workboard-%' AND ${key} LIKE '%:' || session_key)`,
      sql<SqlBool>`(execution_session_key LIKE 'subagent:workboard-%' AND ${key} LIKE '%:' || execution_session_key)`,
      sql<SqlBool>`(COALESCE(session_key, '') = '' AND ${key} LIKE '%subagent:workboard-%' || id)`,
      sql<SqlBool>`EXISTS (
        SELECT 1 FROM workboard_card_attempts AS attempt
        WHERE attempt.card_id = workboard_cards.id
          AND (
            attempt.session_key = ${key}
            OR (attempt.session_key LIKE 'subagent:workboard-%'
              AND ${key} LIKE '%:' || attempt.session_key)
          )
      )`,
      sql<SqlBool>`EXISTS (
        SELECT 1 FROM workboard_card_events AS event
        WHERE event.card_id = workboard_cards.id
          AND (
            event.session_key = ${key}
            OR (event.session_key LIKE 'subagent:workboard-%'
              AND ${key} LIKE '%:' || event.session_key)
          )
      )`,
    );
  }
  if (source.runId) {
    const runId = source.runId;
    clauses.push(
      sql<SqlBool>`run_id = ${runId}`,
      sql<SqlBool>`execution_run_id = ${runId}`,
      sql<SqlBool>`run_id LIKE 'workboard:' || id || ':%'`,
      sql<SqlBool>`EXISTS (SELECT 1 FROM workboard_card_attempts AS attempt
        WHERE attempt.card_id = workboard_cards.id AND attempt.run_id = ${runId})`,
      sql<SqlBool>`EXISTS (SELECT 1 FROM workboard_card_events AS event
        WHERE event.card_id = workboard_cards.id AND event.run_id = ${runId})`,
    );
  }
  if (clauses.length === 0) {
    return [];
  }
  return readIds(
    db,
    sql<SqlBool>`archived_at IS NULL AND (${sql.join(clauses, sql<SqlBool>` OR `)})`,
    source.boardId,
  );
}
