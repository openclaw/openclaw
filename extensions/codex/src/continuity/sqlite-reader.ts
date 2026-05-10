import crypto from "node:crypto";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { type CodexBridgeGoalState, type CodexBridgeThread } from "./types.js";

type ThreadGoalRow = {
  id: string;
  title: string;
  first_user_message: string;
  cwd: string;
  git_branch: string | null;
  model: string | null;
  model_provider: string | null;
  archived: number | bigint | null;
  created_at_ms: number | bigint | null;
  updated_at_ms: number | bigint | null;
  goal_id: string | null;
  objective: string | null;
  goal_status: string | null;
  token_budget: number | bigint | null;
  tokens_used: number | bigint | null;
  time_used_seconds: number | bigint | null;
  goal_created_at_ms: number | bigint | null;
  goal_updated_at_ms: number | bigint | null;
};

export type SqliteThreadReadResult =
  | { ok: true; threads: CodexBridgeThread[]; warnings: string[] }
  | { ok: false; error: string; threads: CodexBridgeThread[]; warnings: string[] };

export async function readCodexThreadsFromSqlite(params: {
  sqliteStatePath: string;
  limit: number;
  nowMs?: number;
}): Promise<SqliteThreadReadResult> {
  if (!existsSync(params.sqliteStatePath)) {
    return {
      ok: false,
      threads: [],
      warnings: [],
      error: `Codex SQLite state not found: ${params.sqliteStatePath}`,
    };
  }
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = await import("node:sqlite");
  } catch (error) {
    return {
      ok: false,
      threads: [],
      warnings: [],
      error: `SQLite support unavailable: ${formatError(error)}`,
    };
  }

  let db: DatabaseSync | undefined;
  try {
    db = new sqlite.DatabaseSync(params.sqliteStatePath, { readOnly: true });
    const rows = db
      .prepare(
        `
        SELECT
          t.id,
          t.title,
          t.first_user_message,
          t.cwd,
          t.git_branch,
          t.model,
          t.model_provider,
          t.archived,
          t.created_at_ms,
          t.updated_at_ms,
          g.goal_id,
          g.objective,
          g.status AS goal_status,
          g.token_budget,
          g.tokens_used,
          g.time_used_seconds,
          g.created_at_ms AS goal_created_at_ms,
          g.updated_at_ms AS goal_updated_at_ms
        FROM threads t
        LEFT JOIN thread_goals g ON g.thread_id = t.id
        WHERE COALESCE(t.archived, 0) = 0
        ORDER BY COALESCE(t.updated_at_ms, t.updated_at * 1000) DESC, t.id DESC
        LIMIT ?
      `,
      )
      .all(Math.max(1, Math.min(100, Math.floor(params.limit)))) as ThreadGoalRow[];
    const nowMs = params.nowMs ?? Date.now();
    return {
      ok: true,
      warnings: ["using read-only SQLite fallback; data may be stale"],
      threads: rows.map((row) => rowToThread(row, nowMs)),
    };
  } catch (error) {
    return {
      ok: false,
      threads: [],
      warnings: ["SQLite fallback failed; Codex schema may have changed"],
      error: formatError(error),
    };
  } finally {
    db?.close();
  }
}

function rowToThread(row: ThreadGoalRow, nowMs: number): CodexBridgeThread {
  const updatedAtMs = normalizeNumber(row.updated_at_ms);
  const goal = row.objective || row.goal_id || row.goal_status ? rowToGoal(row) : undefined;
  const ageMs = updatedAtMs != null ? nowMs - updatedAtMs : Number.POSITIVE_INFINITY;
  return {
    id: row.id,
    title: normalizeText(row.title) ?? normalizeText(row.first_user_message),
    preview: normalizeText(row.first_user_message),
    cwd: normalizeText(row.cwd),
    branch: normalizeText(row.git_branch),
    model: normalizeText(row.model),
    modelProvider: normalizeText(row.model_provider),
    archived: normalizeNumber(row.archived) === 1,
    source: "sqlite",
    stale: ageMs > 2 * 60 * 1000,
    status: normalizeStatus(row.goal_status),
    createdAtMs: normalizeNumber(row.created_at_ms),
    updatedAtMs,
    ...(goal ? { goal } : {}),
  };
}

function rowToGoal(row: ThreadGoalRow): CodexBridgeGoalState {
  const objective = normalizeText(row.objective);
  const goalId = normalizeText(row.goal_id);
  const createdAtMs = normalizeNumber(row.goal_created_at_ms);
  return {
    goalKey: hashGoalKey(row.id, objective, createdAtMs),
    ...(goalId ? { goalId } : {}),
    ...(objective ? { objective } : {}),
    ...(normalizeText(row.goal_status) ? { status: normalizeText(row.goal_status) } : {}),
    tokenBudget: normalizeNumber(row.token_budget),
    tokensUsed: normalizeNumber(row.tokens_used),
    timeUsedSeconds: normalizeNumber(row.time_used_seconds),
    createdAtMs,
    updatedAtMs: normalizeNumber(row.goal_updated_at_ms),
  };
}

export function hashGoalKey(
  threadId: string,
  objective: string | undefined,
  createdAtMs: number | undefined,
): string {
  return crypto
    .createHash("sha256")
    .update(`${threadId}\0${objective ?? ""}\0${createdAtMs ?? ""}`)
    .digest("hex")
    .slice(0, 24);
}

function normalizeStatus(value: string | null): CodexBridgeThread["status"] {
  if (value === "active") {
    return "active";
  }
  if (value === "complete") {
    return "complete";
  }
  if (value === "paused") {
    return "paused";
  }
  if (value === "budget_limited") {
    return "budget_limited";
  }
  return "idle";
}

function normalizeText(value: string | null): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
