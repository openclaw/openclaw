/**
 * SQLite adapter for the subagent run registry.
 *
 * Maps SubagentRunRecord to the op1_subagent_runs table.
 */
import type { DatabaseSync } from "node:sqlite";
import { getStateDb } from "../infra/state-db/connection.js";
import { runMigrations } from "../infra/state-db/schema.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

// ── DB provider (overridable for tests) ─────────────────────────────────────

let _dbOverride: DatabaseSync | null = null;

export function setSubagentRegistryDbForTest(db: DatabaseSync): void {
  _dbOverride = db;
}

export function resetSubagentRegistryDbForTest(): void {
  _dbOverride = null;
}

export function initSubagentRegistryTestDb(db: DatabaseSync): DatabaseSync {
  runMigrations(db);
  setSubagentRegistryDbForTest(db);
  return db;
}

function resolveDb(): DatabaseSync {
  return _dbOverride ?? getStateDb();
}

// ── Row type ────────────────────────────────────────────────────────────────

type RunRow = {
  run_id: string;
  child_session_key: string;
  requester_session_key: string;
  requester_display_key: string | null;
  requester_origin_json: string | null;
  task: string | null;
  cleanup: string | null;
  label: string | null;
  model: string | null;
  workspace_dir: string | null;
  run_timeout_seconds: number | null;
  spawn_mode: string | null;
  created_at: number | null;
  started_at: number | null;
  ended_at: number | null;
  outcome_json: string | null;
  archive_at_ms: number | null;
  cleanup_completed_at: number | null;
  cleanup_handled: number | null;
  suppress_announce_reason: string | null;
  expects_completion_message: number | null;
  announce_retry_count: number | null;
  last_announce_retry_at: number | null;
  ended_reason: string | null;
  wake_on_descendant_settle: number | null;
  frozen_result_text: string | null;
  frozen_result_captured_at: number | null;
  fallback_frozen_result_text: string | null;
  fallback_frozen_result_captured_at: number | null;
  ended_hook_emitted_at: number | null;
  attachments_dir: string | null;
  attachments_root_dir: string | null;
  retain_attachments_on_keep: number | null;
  team_run_id: string | null;
  spawn_retry_count: number | null;
  agent_id: string | null;
};

// ── Row ↔ Type conversions ─────────────────────────────────────────────────

function rowToRecord(row: RunRow): SubagentRunRecord {
  const rec: SubagentRunRecord = {
    runId: row.run_id,
    childSessionKey: row.child_session_key,
    requesterSessionKey: row.requester_session_key,
    requesterDisplayKey: row.requester_display_key ?? "",
    task: row.task ?? "",
    cleanup: row.cleanup === "keep" ? "keep" : "delete",
    createdAt: row.created_at ?? 0,
  };
  if (row.requester_origin_json) {
    try {
      rec.requesterOrigin = JSON.parse(row.requester_origin_json);
    } catch {
      /* ignore */
    }
  }
  if (row.label != null) {
    rec.label = row.label;
  }
  if (row.model != null) {
    rec.model = row.model;
  }
  if (row.workspace_dir != null) {
    rec.workspaceDir = row.workspace_dir;
  }
  if (row.run_timeout_seconds != null) {
    rec.runTimeoutSeconds = row.run_timeout_seconds;
  }
  if (row.spawn_mode != null) {
    rec.spawnMode = row.spawn_mode as SubagentRunRecord["spawnMode"];
  }
  if (row.started_at != null) {
    rec.startedAt = row.started_at;
  }
  if (row.ended_at != null) {
    rec.endedAt = row.ended_at;
  }
  if (row.outcome_json) {
    try {
      rec.outcome = JSON.parse(row.outcome_json);
    } catch {
      /* ignore */
    }
  }
  if (row.archive_at_ms != null) {
    rec.archiveAtMs = row.archive_at_ms;
  }
  if (row.cleanup_completed_at != null) {
    rec.cleanupCompletedAt = row.cleanup_completed_at;
  }
  if (row.cleanup_handled) {
    rec.cleanupHandled = true;
  }
  if (row.suppress_announce_reason != null) {
    rec.suppressAnnounceReason =
      row.suppress_announce_reason as SubagentRunRecord["suppressAnnounceReason"];
  }
  if (row.expects_completion_message) {
    rec.expectsCompletionMessage = true;
  }
  if (row.announce_retry_count != null) {
    rec.announceRetryCount = row.announce_retry_count;
  }
  if (row.last_announce_retry_at != null) {
    rec.lastAnnounceRetryAt = row.last_announce_retry_at;
  }
  if (row.ended_reason != null) {
    rec.endedReason = row.ended_reason as SubagentRunRecord["endedReason"];
  }
  if (row.wake_on_descendant_settle) {
    rec.wakeOnDescendantSettle = true;
  }
  if (row.frozen_result_text !== null) {
    rec.frozenResultText = row.frozen_result_text;
  }
  if (row.frozen_result_captured_at != null) {
    rec.frozenResultCapturedAt = row.frozen_result_captured_at;
  }
  if (row.fallback_frozen_result_text !== null) {
    rec.fallbackFrozenResultText = row.fallback_frozen_result_text;
  }
  if (row.fallback_frozen_result_captured_at != null) {
    rec.fallbackFrozenResultCapturedAt = row.fallback_frozen_result_captured_at;
  }
  if (row.ended_hook_emitted_at != null) {
    rec.endedHookEmittedAt = row.ended_hook_emitted_at;
  }
  if (row.attachments_dir != null) {
    rec.attachmentsDir = row.attachments_dir;
  }
  if (row.attachments_root_dir != null) {
    rec.attachmentsRootDir = row.attachments_root_dir;
  }
  if (row.retain_attachments_on_keep) {
    rec.retainAttachmentsOnKeep = true;
  }
  if (row.team_run_id != null) {
    rec.teamRunId = row.team_run_id;
  }
  if (row.spawn_retry_count != null && row.spawn_retry_count > 0) {
    rec.spawnRetryCount = row.spawn_retry_count;
  }
  if (row.agent_id != null) {
    rec.agentId = row.agent_id;
  }
  return rec;
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export function saveSubagentRunToDb(rec: SubagentRunRecord): void {
  const db = resolveDb();
  try {
    db.prepare(
      `INSERT OR REPLACE INTO op1_subagent_runs (
        run_id, child_session_key, requester_session_key, requester_display_key,
        requester_origin_json, task, cleanup, label, model, workspace_dir,
        run_timeout_seconds, spawn_mode, created_at, started_at, ended_at,
        outcome_json, archive_at_ms, cleanup_completed_at, cleanup_handled,
        suppress_announce_reason, expects_completion_message,
        announce_retry_count, last_announce_retry_at, ended_reason,
        wake_on_descendant_settle, frozen_result_text, frozen_result_captured_at,
        fallback_frozen_result_text, fallback_frozen_result_captured_at,
        ended_hook_emitted_at, attachments_dir, attachments_root_dir,
        retain_attachments_on_keep, team_run_id, spawn_retry_count, agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rec.runId,
      rec.childSessionKey,
      rec.requesterSessionKey,
      rec.requesterDisplayKey ?? null,
      rec.requesterOrigin ? JSON.stringify(rec.requesterOrigin) : null,
      rec.task ?? null,
      rec.cleanup,
      rec.label ?? null,
      rec.model ?? null,
      rec.workspaceDir ?? null,
      rec.runTimeoutSeconds ?? null,
      rec.spawnMode ?? null,
      rec.createdAt,
      rec.startedAt ?? null,
      rec.endedAt ?? null,
      rec.outcome ? JSON.stringify(rec.outcome) : null,
      rec.archiveAtMs ?? null,
      rec.cleanupCompletedAt ?? null,
      rec.cleanupHandled ? 1 : 0,
      rec.suppressAnnounceReason ?? null,
      rec.expectsCompletionMessage ? 1 : 0,
      rec.announceRetryCount ?? 0,
      rec.lastAnnounceRetryAt ?? null,
      rec.endedReason ?? null,
      rec.wakeOnDescendantSettle ? 1 : 0,
      rec.frozenResultText ?? null,
      rec.frozenResultCapturedAt ?? null,
      rec.fallbackFrozenResultText ?? null,
      rec.fallbackFrozenResultCapturedAt ?? null,
      rec.endedHookEmittedAt ?? null,
      rec.attachmentsDir ?? null,
      rec.attachmentsRootDir ?? null,
      rec.retainAttachmentsOnKeep ? 1 : 0,
      rec.teamRunId ?? null,
      rec.spawnRetryCount ?? 0,
      rec.agentId ?? null,
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}

export function loadSubagentRunFromDb(runId: string): SubagentRunRecord | null {
  const db = resolveDb();
  try {
    const row = db.prepare("SELECT * FROM op1_subagent_runs WHERE run_id = ?").get(runId) as
      | RunRow
      | undefined;
    return row ? rowToRecord(row) : null;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return null;
    }
    throw err;
  }
}

export function loadAllSubagentRunsFromDb(): Map<string, SubagentRunRecord> {
  const db = resolveDb();
  try {
    const rows = db.prepare("SELECT * FROM op1_subagent_runs").all() as RunRow[];
    const out = new Map<string, SubagentRunRecord>();
    for (const row of rows) {
      out.set(row.run_id, rowToRecord(row));
    }
    return out;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return new Map();
    }
    throw err;
  }
}

export function deleteSubagentRunFromDb(runId: string): boolean {
  const db = resolveDb();
  try {
    const result = db.prepare("DELETE FROM op1_subagent_runs WHERE run_id = ?").run(runId);
    return result.changes > 0;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return false;
    }
    throw err;
  }
}

export function markActiveSubagentRunsInterrupted(reason: string): number {
  // Query op1_subagent_runs for active runs and mark them as interrupted.
  // This runs during gateway shutdown, so use direct DB access synchronously.
  try {
    const db = resolveDb();
    const now = Date.now();
    const result = db
      .prepare(
        `UPDATE op1_subagent_runs
         SET ended_at = ?,
             outcome_json = ?,
             ended_reason = ?,
             cleanup_completed_at = ?
         WHERE ended_at IS NULL AND started_at IS NOT NULL`,
      )
      .run(now, JSON.stringify({ status: "interrupted", reason }), reason, now);
    return typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
  } catch {
    return 0;
  }
}

export function saveAllSubagentRunsToDb(runs: Map<string, SubagentRunRecord>): void {
  const db = resolveDb();
  try {
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM op1_subagent_runs");
      for (const rec of runs.values()) {
        saveSubagentRunToDb(rec);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}
