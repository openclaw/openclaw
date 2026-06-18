import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { CompiledQuery, Insertable, Selectable, Updateable } from "kysely";
import { getNodeSqliteKysely } from "../../src/infra/kysely-sync.js";
import { requireNodeSqlite } from "../../src/infra/node-sqlite.js";
import type { IssueFixAgentRun, IssueFixAgentState } from "./types.js";

type CompilableQuery<Row = unknown> = {
  compile(): CompiledQuery<Row>;
};

type RunsTable = {
  run_id: string;
  issue_number: number;
  issue_title: string;
  issue_url: string;
  source: string;
  state: IssueFixAgentState;
  created_at: string;
  updated_at: string;
  branch_name: string | null;
  worktree_path: string | null;
  commit_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  terminal_reason: string | null;
};

type EventsTable = {
  id: number;
  run_id: string;
  kind: string;
  payload_json: string;
  created_at: string;
};

type ChecksTable = {
  id: number;
  run_id: string;
  pr_number: number;
  head_sha: string;
  name: string;
  status: string;
  conclusion: string | null;
  details_url: string | null;
  created_at: string;
};

type IssueFixAgentDb = {
  issue_fix_agent_runs: RunsTable;
  issue_fix_agent_events: EventsTable;
  issue_fix_agent_checks: ChecksTable;
};

export type IssueFixAgentStateStore = {
  readonly db: DatabaseSync;
  close(): void;
};

const stateOrder: IssueFixAgentState[] = [
  "discovered",
  "qualified",
  "claimed_local",
  "branch_created",
  "patching",
  "verifying",
  "committed",
  "pr_opened",
  "monitoring",
  "land_ready",
  "blocked",
];

function nowIso(): string {
  return new Date().toISOString();
}

function randomRunId(): string {
  return `ifr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function rowToRun(row: Selectable<RunsTable>): IssueFixAgentRun {
  return {
    branchName: row.branch_name,
    commitSha: row.commit_sha,
    createdAt: row.created_at,
    issueNumber: row.issue_number,
    issueTitle: row.issue_title,
    issueUrl: row.issue_url,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    runId: row.run_id,
    source: row.source,
    state: row.state,
    terminalReason: row.terminal_reason,
    updatedAt: row.updated_at,
    worktreePath: row.worktree_path,
  };
}

function executeIssueFixWrite(db: DatabaseSync, query: CompilableQuery): void {
  const compiled = query.compile();
  db.prepare(compiled.sql).run(...(compiled.parameters as SQLInputValue[]));
}

function executeIssueFixRows<Row>(db: DatabaseSync, query: CompilableQuery<Row>): Row[] {
  const compiled = query.compile();
  return db.prepare(compiled.sql).all(...(compiled.parameters as SQLInputValue[])) as Row[];
}

function executeIssueFixTakeFirst<Row>(
  db: DatabaseSync,
  query: CompilableQuery<Row>,
): Row | undefined {
  return executeIssueFixRows(db, query)[0];
}

export function openIssueFixAgentState(dbPath: string): IssueFixAgentStateStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`
    create table if not exists issue_fix_agent_runs (
      run_id text primary key,
      issue_number integer not null,
      issue_title text not null,
      issue_url text not null,
      source text not null,
      state text not null,
      created_at text not null,
      updated_at text not null,
      branch_name text,
      worktree_path text,
      commit_sha text,
      pr_number integer,
      pr_url text,
      terminal_reason text
    );
    create table if not exists issue_fix_agent_events (
      id integer primary key autoincrement,
      run_id text not null,
      kind text not null,
      payload_json text not null,
      created_at text not null
    );
    create table if not exists issue_fix_agent_checks (
      id integer primary key autoincrement,
      run_id text not null,
      pr_number integer not null,
      head_sha text not null,
      name text not null,
      status text not null,
      conclusion text,
      details_url text,
      created_at text not null
    );
  `);
  return { db, close: () => db.close() };
}

export function createIssueFixAgentRun(
  store: IssueFixAgentStateStore,
  input: { issueNumber: number; issueTitle: string; issueUrl: string; source: string },
): IssueFixAgentRun {
  const now = nowIso();
  const row: Insertable<RunsTable> = {
    branch_name: null,
    commit_sha: null,
    created_at: now,
    issue_number: input.issueNumber,
    issue_title: input.issueTitle,
    issue_url: input.issueUrl,
    pr_number: null,
    pr_url: null,
    run_id: randomRunId(),
    source: input.source,
    state: "discovered",
    terminal_reason: null,
    updated_at: now,
    worktree_path: null,
  };
  const kysely = getNodeSqliteKysely<IssueFixAgentDb>(store.db);
  executeIssueFixWrite(store.db, kysely.insertInto("issue_fix_agent_runs").values(row));
  return rowToRun(row as Selectable<RunsTable>);
}

export function getIssueFixAgentRun(
  store: IssueFixAgentStateStore,
  runId: string,
): IssueFixAgentRun | null {
  const kysely = getNodeSqliteKysely<IssueFixAgentDb>(store.db);
  const row = executeIssueFixTakeFirst(
    store.db,
    kysely.selectFrom("issue_fix_agent_runs").selectAll().where("run_id", "=", runId),
  );
  return row ? rowToRun(row) : null;
}

export function transitionIssueFixAgentRun(
  store: IssueFixAgentStateStore,
  runId: string,
  nextState: IssueFixAgentState,
  params: { reason: string },
): void {
  const current = getIssueFixAgentRun(store, runId);
  if (!current) {
    throw new Error(`unknown issue-fix-agent run: ${runId}`);
  }
  const currentIndex = stateOrder.indexOf(current.state);
  const nextIndex = stateOrder.indexOf(nextState);
  if (nextIndex < currentIndex && current.state !== "blocked") {
    throw new Error(`invalid issue-fix-agent transition ${current.state} -> ${nextState}`);
  }
  const patch: Updateable<RunsTable> = {
    state: nextState,
    terminal_reason: nextState === "blocked" ? params.reason : current.terminalReason,
    updated_at: nowIso(),
  };
  const kysely = getNodeSqliteKysely<IssueFixAgentDb>(store.db);
  executeIssueFixWrite(
    store.db,
    kysely.updateTable("issue_fix_agent_runs").set(patch).where("run_id", "=", runId),
  );
  appendIssueFixAgentEvent(store, runId, "transition", { nextState, reason: params.reason });
}

export function getLatestOpenIssueFixAgentRun(
  store: IssueFixAgentStateStore,
): IssueFixAgentRun | null {
  const kysely = getNodeSqliteKysely<IssueFixAgentDb>(store.db);
  const row = executeIssueFixTakeFirst(
    store.db,
    kysely
      .selectFrom("issue_fix_agent_runs")
      .selectAll()
      .where("state", "not in", ["land_ready", "blocked"])
      .orderBy("created_at", "desc")
      .limit(1),
  );
  return row ? rowToRun(row) : null;
}

export function appendIssueFixAgentEvent(
  store: IssueFixAgentStateStore,
  runId: string,
  kind: string,
  payload: unknown,
): void {
  const kysely = getNodeSqliteKysely<IssueFixAgentDb>(store.db);
  executeIssueFixWrite(
    store.db,
    kysely.insertInto("issue_fix_agent_events").values({
      created_at: nowIso(),
      kind,
      payload_json: JSON.stringify(payload),
      run_id: runId,
    }),
  );
}
