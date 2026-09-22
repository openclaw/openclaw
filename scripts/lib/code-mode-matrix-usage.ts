import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonEmptyStringPreservingWhitespace } from "@openclaw/normalization-core/string-coerce";
import {
  hasRecordedUsageCost,
  normalizeUsage,
  type NormalizedUsage,
} from "../../src/agents/usage.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../../src/infra/kysely-sync.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../src/shared/transcript-only-openclaw-assistant.js";
import type { DB as AgentDatabase } from "../../src/state/openclaw-agent-db.generated.js";
import type { DB as StateDatabase } from "../../src/state/openclaw-state-db.generated.js";
import { readSqliteTranscriptPayload } from "./sqlite-transcript-payload.mjs";

const MAX_ROWS = 20_000;
const MAX_BYTES = 64 * 1024 * 1024;
const TOKEN_BUCKETS = ["input", "output", "cacheRead", "cacheWrite"] as const;

type ReportedUsage = Pick<
  NormalizedUsage,
  "input" | "output" | "cacheRead" | "cacheWrite" | "total"
> & { costUsd?: number };

export type MatrixLedgerRow = {
  storeId: string;
  sessionId: string;
  sessionKey: string;
  seq: number;
  sha256: string;
  event: unknown;
};

type MatrixLedgerSession = {
  storeId: string;
  sessionId: string;
  sessionKey: string;
  parentSessionKey?: string;
  spawnedBy?: string;
  generation?: string;
  historyRewritten: boolean;
  runUsage?: { runId?: string; usage: ReportedUsage };
};

type MatrixLedgerRun = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterStorePath: string | null;
  executionStatus: string;
  startedAt?: number;
  endedAt?: number;
};

export type MatrixSessionLedger = {
  stores: Record<string, string>;
  rows: MatrixLedgerRow[];
  sessions: MatrixLedgerSession[];
  runs: MatrixLedgerRun[];
  issues: string[];
};

export type MatrixLedgerBoundary = {
  sessionKeys: string[];
  stores: Record<string, string>;
  sessions: Record<string, number>;
  rows: Record<string, string>;
  generations: Record<string, string>;
  runs: Record<string, string>;
};

function sessionIdentity(row: Pick<MatrixLedgerRow, "storeId" | "sessionId">): string {
  return JSON.stringify([row.storeId, row.sessionId]);
}

function rowIdentity(row: MatrixLedgerRow): string {
  return JSON.stringify([row.storeId, row.sessionId, row.seq]);
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** Read only the disposable benchmark state; never open a runtime writer or migrate a store. */
export async function readMatrixSessionLedger(stateDir: string): Promise<MatrixSessionLedger> {
  const ledger: MatrixSessionLedger = { stores: {}, rows: [], sessions: [], runs: [], issues: [] };
  const root = await fs.realpath(stateDir);
  const agentsDir = path.join(root, "agents");
  const entries = (await exists(agentsDir))
    ? await fs.readdir(agentsDir, { withFileTypes: true })
    : [];
  if (entries.length > 64) {
    ledger.issues.push("Agent store inventory exceeds the benchmark bound.");
    return ledger;
  }
  let bytes = 0;
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const file = path.join(agentsDir, entry.name, "agent", "openclaw-agent.sqlite");
    if (!(await exists(file))) {
      continue;
    }
    const resolved = await fs.realpath(file);
    const storeId = path.relative(root, resolved);
    if (storeId.startsWith("..") || path.isAbsolute(storeId)) {
      ledger.issues.push(`Agent store escapes isolated state: ${entry.name}`);
      continue;
    }
    const physical = await fs.stat(resolved);
    ledger.stores[storeId] = `${physical.dev}:${physical.ino}`;
    const db = new DatabaseSync(resolved, { readOnly: true });
    try {
      db.exec("BEGIN");
      const query = getNodeSqliteKysely<AgentDatabase>(db);
      const sessions = executeSqliteQuerySync(
        db,
        query
          .selectFrom("session_windows as window")
          .innerJoin("session_nodes as node", "node.session_key", "window.session_key")
          .select(["window.session_id", "window.session_key", "window.reason", "node.entry_json"])
          .limit(MAX_ROWS + 1),
      ).rows;
      const generations = new Map(
        executeSqliteQuerySync(
          db,
          query
            .selectFrom("transcript_rewrite_watermarks")
            .select(["session_id", "generation"])
            .limit(MAX_ROWS + 1),
        ).rows.map((row) => [row.session_id, row.generation]),
      );
      const archived = executeSqliteQuerySync(
        db,
        query
          .selectFrom("session_transcript_archives")
          .select("session_id")
          .limit(MAX_ROWS + 1),
      ).rows;
      const archivedSessions = new Set(archived.map((row) => row.session_id));
      if (sessions.length > MAX_ROWS || generations.size > MAX_ROWS || archived.length > MAX_ROWS) {
        throw new Error("Session metadata exceeds the benchmark bound.");
      }
      const sessionKeys = new Map<string, string>();
      for (const session of sessions) {
        const value: unknown = JSON.parse(session.entry_json);
        if (!isRecord(value)) {
          throw new Error("Invalid canonical session metadata.");
        }
        sessionKeys.set(session.session_id, session.session_key);
        ledger.sessions.push({
          storeId,
          sessionId: session.session_id,
          sessionKey: session.session_key,
          parentSessionKey: readNonEmptyStringPreservingWhitespace(value.parentSessionKey),
          spawnedBy: readNonEmptyStringPreservingWhitespace(value.spawnedBy),
          generation: generations.get(session.session_id),
          runUsage: {
            runId: readNonEmptyStringPreservingWhitespace(value.lastRunId),
            usage: {
              input: count(value.inputTokens),
              output: count(value.outputTokens),
              cacheRead: count(value.cacheRead),
              cacheWrite: count(value.cacheWrite),
              ...(typeof value.estimatedCostUsd === "number" &&
              Number.isFinite(value.estimatedCostUsd) &&
              value.estimatedCostUsd >= 0
                ? { costUsd: value.estimatedCostUsd }
                : {}),
            },
          },
          historyRewritten:
            archivedSessions.has(session.session_id) ||
            session.reason === "fork" ||
            session.reason === "compaction",
        });
      }
      const rows = iterateSqliteQuerySync(
        db,
        query
          .selectFrom("transcript_events")
          .select(["session_id", "seq", "event_json", "event_zstd", "event_utf8_bytes"])
          .orderBy("session_id")
          .orderBy("seq")
          .limit(MAX_ROWS - ledger.rows.length + 1),
      );
      for (const row of rows) {
        const json = readSqliteTranscriptPayload(row);
        bytes += Buffer.byteLength(json);
        if (ledger.rows.length >= MAX_ROWS || bytes > MAX_BYTES) {
          throw new Error("Transcript materialization exceeds the benchmark bound.");
        }
        const sessionKey = sessionKeys.get(row.session_id);
        if (!sessionKey) {
          throw new Error("Transcript has no canonical session identity.");
        }
        ledger.rows.push({
          storeId,
          sessionId: row.session_id,
          sessionKey,
          seq: row.seq,
          sha256: createHash("sha256").update(json).digest("hex"),
          event: JSON.parse(json),
        });
      }
    } catch (error) {
      ledger.issues.push(`${storeId}: ${error instanceof Error ? error.message : "read failed"}`);
    } finally {
      db.close();
    }
    const after = await fs.stat(resolved);
    if (physical.dev !== after.dev || physical.ino !== after.ino) {
      ledger.issues.push(`Agent store changed during observation: ${storeId}`);
    }
  }
  const registryPath = path.join(root, "state", "openclaw.sqlite");
  if (await exists(registryPath)) {
    const resolved = await fs.realpath(registryPath);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      ledger.issues.push("Subagent registry escapes isolated state.");
      return ledger;
    }
    const db = new DatabaseSync(resolved, { readOnly: true });
    try {
      const rows = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<StateDatabase>(db)
          .selectFrom("subagent_runs")
          .selectAll()
          .limit(MAX_ROWS + 1),
      ).rows;
      if (rows.length > MAX_ROWS) {
        throw new Error("Subagent registry exceeds the benchmark bound.");
      }
      for (const row of rows) {
        const value: unknown = JSON.parse(row.payload_json);
        if (
          !isRecord(value) ||
          !isRecord(value.execution) ||
          typeof value.execution.status !== "string"
        ) {
          throw new Error("Subagent registry lacks canonical execution state.");
        }
        ledger.runs.push({
          runId: row.run_id,
          childSessionKey: row.child_session_key,
          requesterSessionKey: row.requester_session_key,
          requesterStorePath: row.requester_store_path,
          executionStatus: value.execution.status,
          startedAt: count(value.execution.startedAt),
          endedAt: count(value.execution.endedAt),
        });
      }
    } catch (error) {
      ledger.issues.push(
        `Subagent registry: ${error instanceof Error ? error.message : "read failed"}`,
      );
    } finally {
      db.close();
    }
  }
  return ledger;
}

export function captureMatrixLedgerBoundary(ledger: MatrixSessionLedger): MatrixLedgerBoundary {
  const boundary: MatrixLedgerBoundary = {
    sessionKeys: [...new Set(ledger.sessions.map((session) => session.sessionKey))],
    stores: { ...ledger.stores },
    sessions: {},
    rows: {},
    generations: {},
    runs: {},
  };
  for (const run of ledger.runs) {
    boundary.runs[run.runId] = run.executionStatus;
  }
  for (const session of ledger.sessions) {
    if (session.generation) {
      boundary.generations[sessionIdentity(session)] = session.generation;
    }
  }
  for (const row of ledger.rows) {
    const identity = sessionIdentity(row);
    boundary.sessions[identity] = Math.max(boundary.sessions[identity] ?? -1, row.seq);
    boundary.rows[rowIdentity(row)] = row.sha256;
  }
  return boundary;
}

type MatrixLedgerSelection = {
  ledger: MatrixSessionLedger;
  before?: MatrixLedgerBoundary;
  after?: MatrixLedgerBoundary;
  rootSessionKeys?: readonly string[];
};

export function selectMatrixLedgerRows(params: MatrixLedgerSelection) {
  const { ledger, before, after } = params;
  const issues = [...ledger.issues];
  const parentKeys = new Map<string, Set<string>>();
  const stores = new Map<string, Set<string>>();
  for (const session of ledger.sessions) {
    const parents = parentKeys.get(session.sessionKey) ?? new Set<string>();
    for (const key of [session.parentSessionKey, session.spawnedBy]) {
      if (key) {
        parents.add(key);
      }
    }
    parentKeys.set(session.sessionKey, parents);
    const locations = stores.get(session.sessionKey) ?? new Set<string>();
    locations.add(session.storeId);
    stores.set(session.sessionKey, locations);
  }
  for (const run of ledger.runs) {
    const parents = parentKeys.get(run.childSessionKey) ?? new Set<string>();
    parents.add(run.requesterSessionKey);
    parentKeys.set(run.childSessionKey, parents);
  }
  const rootSessionKeys = params.rootSessionKeys
    ? [...params.rootSessionKeys]
    : [...parentKeys].filter(([, parents]) => parents.size === 0).map(([key]) => key);
  if (rootSessionKeys.length !== 1) {
    issues.push("Accounting requires one unambiguous benchmark root session.");
  }
  const selected = new Set(rootSessionKeys);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [child, parents] of parentKeys) {
      if (!selected.has(child) && [...parents].some((key) => selected.has(key))) {
        selected.add(child);
        changed = true;
      }
    }
  }
  for (const key of selected) {
    if ((stores.get(key)?.size ?? 0) !== 1) {
      issues.push(`Session store identity missing or ambiguous: ${key}`);
    }
  }
  for (const session of ledger.sessions) {
    if (selected.has(session.sessionKey) && session.historyRewritten) {
      issues.push(
        `Original billed history is unavailable after rewrite/archive/fork: ${session.sessionKey}`,
      );
    }
  }
  const rowIndex = new Map(ledger.rows.map((row) => [rowIdentity(row), row]));
  const generations = new Map(
    ledger.sessions.map((session) => [sessionIdentity(session), session.generation]),
  );
  for (const boundary of [before, after]) {
    for (const [storeId, identity] of Object.entries(boundary?.stores ?? {})) {
      if (ledger.stores[storeId] !== identity) {
        issues.push(`Physical session store changed across accounting boundary: ${storeId}`);
      }
    }
    for (const [identity, generation] of Object.entries(boundary?.generations ?? {})) {
      if (generations.get(identity) !== generation) {
        issues.push(`Transcript generation changed across accounting boundary: ${identity}`);
      }
    }
    for (const [identity, hash] of Object.entries(boundary?.rows ?? {})) {
      const row = rowIndex.get(identity);
      if (!row || row.sha256 !== hash) {
        issues.push(`Transcript changed across accounting boundary: ${identity}`);
      }
    }
  }
  const intervalRows = ledger.rows.filter((row) => {
    const identity = sessionIdentity(row);
    return (
      row.seq > (before?.sessions[identity] ?? -1) &&
      (!after || row.seq <= (after.sessions[identity] ?? -1))
    );
  });
  const unattributedRows: MatrixLedgerRow[] = [];
  for (const row of intervalRows) {
    const message =
      isRecord(row.event) && isRecord(row.event.message) ? row.event.message : row.event;
    if (
      !selected.has(row.sessionKey) &&
      isRecord(message) &&
      message.role === "assistant" &&
      !isTranscriptOnlyOpenClawAssistantMessage(message)
    ) {
      issues.push(`Unattributed model response in isolated task interval: ${rowIdentity(row)}`);
      unattributedRows.push(row);
    }
  }
  const rows = intervalRows.filter((row) => selected.has(row.sessionKey));
  return {
    rows,
    unattributedRows,
    rootSessionKeys,
    descendantSessionKeys: [...selected].filter((key) => !rootSessionKeys.includes(key)),
    issues,
  };
}

type MatrixUsageTotals = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  knownTotalTokens: number;
  knownCostUsd: number;
  assistantTurns: number;
};

export type MatrixUsageAccounting = MatrixUsageTotals & {
  coverage: "observed-transcripts-reconciled-with-runtime";
  runtimeReconciliation: RuntimeReconciliation[];
  complete: boolean;
  costComplete: boolean;
  reasoningComplete: boolean;
  totalTokens: number | null;
  costUsd: number | null;
  reasoningTokens: number | null;
  toolFailures: number;
  modelErrors: number;
  costProvenance: string[];
  parents: MatrixUsageTotals;
  descendants: MatrixUsageTotals;
  unattributed: MatrixUsageTotals;
  sessionKeys: string[];
  issues: string[];
  costIssues: string[];
  childRuns: { accepted: number; terminal: number; peakConcurrent: number | null };
};

type RuntimeReconciliation = {
  source: "root-response" | "child-session";
  sessionKey: string;
  runId?: string;
  reported: ReportedUsage | null;
  transcript: MatrixUsageTotals;
  tokenGap: number;
  costGapUsd: number;
  matched: boolean;
  costMatched: boolean | null;
};

function reconcileRuntimeUsage(
  identity: Pick<RuntimeReconciliation, "source" | "sessionKey" | "runId">,
  reported: ReportedUsage | undefined,
  transcript: MatrixUsageTotals,
): RuntimeReconciliation {
  const completeBuckets =
    reported !== undefined && TOKEN_BUCKETS.every((key) => count(reported[key]) !== undefined);
  const bucketTotal = TOKEN_BUCKETS.reduce((sum, key) => sum + (count(reported?.[key]) ?? 0), 0);
  const reportedTotal = count(reported?.total) ?? (completeBuckets ? bucketTotal : undefined);
  // Session estimates can contain catalog placeholders; zero is not price evidence.
  const reportedCost =
    reported?.costUsd !== undefined && reported.costUsd > 0 ? reported.costUsd : undefined;
  return {
    ...identity,
    reported: reported ?? null,
    transcript: { ...transcript },
    tokenGap: Math.max(0, Math.max(bucketTotal, reportedTotal ?? 0) - transcript.knownTotalTokens),
    costGapUsd: Math.max(0, (reportedCost ?? 0) - transcript.knownCostUsd),
    matched:
      completeBuckets &&
      reportedTotal === bucketTotal &&
      reportedTotal === transcript.knownTotalTokens &&
      TOKEN_BUCKETS.every((key) => reported?.[key] === transcript[key]),
    costMatched:
      reportedCost === undefined ? null : Math.abs(reportedCost - transcript.knownCostUsd) < 1e-9,
  };
}

function emptyTotals(): MatrixUsageTotals {
  return {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    knownTotalTokens: 0,
    knownCostUsd: 0,
    assistantTurns: 0,
  };
}

/** All attempts count, including failed tools and model errors; reasoning is a subset of output. */
export function collectMatrixUsage(
  params: MatrixLedgerSelection & {
    settled: boolean;
    terminalResponseObserved: boolean;
    rootUsage: unknown;
    runtimeLog?: string;
  },
): MatrixUsageAccounting {
  const selection = selectMatrixLedgerRows(params);
  const issues = [...selection.issues];
  const costIssues: string[] = [];
  const parents = emptyTotals();
  const descendants = emptyTotals();
  const unattributed = emptyTotals();
  const total = emptyTotals();
  const sessionTotals = new Map<string, MatrixUsageTotals>();
  const costProvenance = new Set<string>();
  let reasoningTokens = 0;
  let reasoningComplete = true;
  let toolFailures = 0;
  let modelErrors = 0;
  const seenRows = new Set<string>();
  const responses = new Set<string>();
  const failedNestedParents = new Set<string>();
  const observedRows = [...selection.rows, ...selection.unattributedRows];
  for (const row of observedRows) {
    const message =
      isRecord(row.event) && isRecord(row.event.message) ? row.event.message : row.event;
    if (
      isRecord(message) &&
      message.customType === "openclaw.nested-tool.v1" &&
      isRecord(message.details) &&
      message.details.isError === true
    ) {
      failedNestedParents.add(
        JSON.stringify([row.storeId, row.sessionId, message.details.parentToolCallId]),
      );
    }
  }
  for (const row of observedRows) {
    const identity = rowIdentity(row);
    if (seenRows.has(identity)) {
      issues.push(`Duplicate transcript row: ${identity}`);
      continue;
    }
    seenRows.add(identity);
    const message =
      isRecord(row.event) && isRecord(row.event.message) ? row.event.message : row.event;
    if (!isRecord(message)) {
      continue;
    }
    if (message.role === "compactionSummary" || message.type === "compaction") {
      issues.push(`Compaction billing is not represented by assistant rows: ${identity}`);
    }
    if (
      message.customType === "openclaw.nested-tool.v1" &&
      isRecord(message.details) &&
      message.details.isError === true
    ) {
      toolFailures += 1;
    } else if (
      message.role === "toolResult" &&
      message.isError === true &&
      !failedNestedParents.has(JSON.stringify([row.storeId, row.sessionId, message.toolCallId]))
    ) {
      toolFailures += 1;
    }
    if (message.role !== "assistant" || isTranscriptOnlyOpenClawAssistantMessage(message)) {
      continue;
    }
    if (typeof message.responseId === "string") {
      const response = JSON.stringify([message.provider, message.model, message.responseId]);
      if (responses.has(response)) {
        issues.push(`Provider response appears more than once: ${response}`);
        continue;
      }
      responses.add(response);
    }
    const scope = selection.rootSessionKeys.includes(row.sessionKey)
      ? parents
      : selection.descendantSessionKeys.includes(row.sessionKey)
        ? descendants
        : unattributed;
    const sessionUsage = sessionTotals.get(row.sessionKey) ?? emptyTotals();
    sessionTotals.set(row.sessionKey, sessionUsage);
    scope.assistantTurns += 1;
    sessionUsage.assistantTurns += 1;
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      modelErrors += 1;
    }
    const raw = isRecord(message.usage) ? message.usage : {};
    const usage = normalizeUsage(raw);
    const buckets = {
      input: count(raw.input),
      output: count(raw.output),
      cacheRead: count(raw.cacheRead),
      cacheWrite: count(raw.cacheWrite),
    };
    const bucketTotal = Object.values(buckets).reduce<number>(
      (sum, value) => sum + (value ?? 0),
      0,
    );
    const reportedTotal = count(raw.totalTokens ?? raw.total);
    const knownTotal = Math.max(bucketTotal, reportedTotal ?? 0);
    scope.knownTotalTokens += knownTotal;
    sessionUsage.knownTotalTokens += knownTotal;
    for (const key of TOKEN_BUCKETS) {
      scope[key] += buckets[key] ?? 0;
      sessionUsage[key] += buckets[key] ?? 0;
    }
    if (
      Object.values(buckets).some((value) => value === undefined) ||
      (reportedTotal !== undefined && reportedTotal !== bucketTotal) ||
      knownTotal === 0
    ) {
      issues.push(`Incomplete or incoherent model usage: ${identity}`);
    }
    const reasoning = count(raw.reasoningTokens);
    if (reasoning === undefined || reasoning > (buckets.output ?? 0)) {
      reasoningComplete = false;
    } else {
      reasoningTokens += reasoning;
    }
    if (usage?.cost && hasRecordedUsageCost(usage.cost)) {
      scope.knownCostUsd += usage.cost.total;
      sessionUsage.knownCostUsd += usage.cost.total;
      costProvenance.add(
        usage.cost.totalOrigin === "provider-billed" ? "provider-billed" : "recorded-estimate",
      );
    } else {
      costIssues.push(`No observed price for model response: ${identity}`);
    }
  }
  for (const key of Object.keys(total) as (keyof MatrixUsageTotals)[]) {
    total[key] = parents[key] + descendants[key] + unattributed[key];
  }
  const sessionKeys = [...selection.rootSessionKeys, ...selection.descendantSessionKeys];
  const childRuns = params.ledger.runs.filter(
    (run) =>
      sessionKeys.includes(run.childSessionKey) &&
      (!params.after || run.runId in params.after.runs) &&
      (params.before?.runs[run.runId] !== "terminal" ||
        selection.rows.some((row) => row.sessionKey === run.childSessionKey)),
  );
  const runtimeReconciliation = [
    reconcileRuntimeUsage(
      { source: "root-response", sessionKey: selection.rootSessionKeys[0] ?? "unresolved-root" },
      isRecord(params.rootUsage) ? normalizeUsage(params.rootUsage) : undefined,
      parents,
    ),
  ];
  for (const child of new Set(childRuns.map((run) => run.childSessionKey))) {
    const runs = params.ledger.runs.filter((run) => run.childSessionKey === child);
    const run = runs.length === 1 ? runs[0] : undefined;
    const snapshot = params.ledger.sessions.find(
      (session) => session.sessionKey === child,
    )?.runUsage;
    if (
      !run ||
      !snapshot ||
      params.before?.sessionKeys.includes(child) ||
      snapshot.runId !== run.runId
    ) {
      issues.push(`Child cumulative usage cannot be bound to one fresh run: ${child}`);
      continue;
    }
    runtimeReconciliation.push(
      reconcileRuntimeUsage(
        { source: "child-session", sessionKey: child, runId: run.runId },
        snapshot.usage,
        sessionTotals.get(child) ?? emptyTotals(),
      ),
    );
  }
  for (const observation of runtimeReconciliation) {
    if (!observation.matched) {
      issues.push(
        `Runtime cumulative usage does not match transcript consumption: ${observation.sessionKey}`,
      );
    }
    if (observation.costMatched === false) {
      costIssues.push(
        `Runtime cumulative cost does not match transcript cost: ${observation.sessionKey}`,
      );
    }
    // Preserve additional observed consumption separately; never invent its bucket split
    // or add a cumulative runtime total to the same already-counted transcript usage.
    total.knownTotalTokens += observation.tokenGap;
    total.knownCostUsd += observation.costGapUsd;
    if (observation.costGapUsd > 0) {
      costProvenance.add("session-run-estimate");
    }
  }
  if (
    /\[responses\] retrying (?:without encrypted|full history|streamed encrypted)/.test(
      params.runtimeLog ?? "",
    )
  ) {
    issues.push("Observed OpenAI request replay recovery without separate failed-request usage.");
  }
  if (
    /\[session-recovery\] Anthropic thinking (?:stream error|error during stream|request rejected); retrying once/.test(
      params.runtimeLog ?? "",
    )
  ) {
    issues.push("Observed Anthropic thinking recovery without separate failed-request usage.");
  }
  for (const run of childRuns) {
    if (run.executionStatus !== "terminal") {
      issues.push(`Child execution has not settled: ${run.runId}`);
    }
    if (
      run.startedAt !== undefined &&
      !selection.rows.some(
        (row) =>
          row.sessionKey === run.childSessionKey &&
          isRecord(row.event) &&
          (row.event.role === "assistant" ||
            (isRecord(row.event.message) && row.event.message.role === "assistant")),
      )
    ) {
      issues.push(`Started child has no model usage evidence: ${run.runId}`);
    }
  }
  for (const child of selection.descendantSessionKeys) {
    if (
      selection.rows.some((row) => row.sessionKey === child) &&
      !params.ledger.runs.some((run) => run.childSessionKey === child)
    ) {
      issues.push(`Child has no execution settlement record: ${child}`);
    }
  }
  if (!params.settled) {
    issues.push("Task process tree has not settled.");
  }
  if (!params.terminalResponseObserved) {
    issues.push("Terminal model response was not observed; in-flight consumption is unknown.");
  }
  if (total.assistantTurns === 0) {
    issues.push("No model response usage observed.");
  }
  const complete = issues.length === 0;
  const costComplete = complete && costIssues.length === 0;
  const timedChildren = childRuns.filter((run) => run.startedAt !== undefined);
  const intervalsComplete = childRuns.every(
    (run) =>
      run.startedAt !== undefined && run.endedAt !== undefined && run.endedAt >= run.startedAt,
  );
  let active = 0;
  let peakConcurrent = 0;
  if (intervalsComplete) {
    const boundaries = timedChildren
      .flatMap((run) =>
        run.endedAt === run.startedAt
          ? []
          : [
              { at: run.startedAt!, change: 1 },
              { at: run.endedAt!, change: -1 },
            ],
      )
      .toSorted((a, b) => a.at - b.at || a.change - b.change);
    for (const boundary of boundaries) {
      active += boundary.change;
      peakConcurrent = Math.max(peakConcurrent, active);
    }
  }
  return {
    ...total,
    coverage: "observed-transcripts-reconciled-with-runtime",
    runtimeReconciliation,
    complete,
    costComplete,
    reasoningComplete: complete && reasoningComplete,
    totalTokens: complete ? total.knownTotalTokens : null,
    costUsd: costComplete ? total.knownCostUsd : null,
    reasoningTokens: complete && reasoningComplete ? reasoningTokens : null,
    toolFailures,
    modelErrors,
    costProvenance: [...costProvenance],
    parents,
    descendants,
    unattributed,
    sessionKeys,
    issues: [...new Set(issues)],
    costIssues,
    childRuns: {
      accepted: childRuns.length,
      terminal: childRuns.filter((run) => run.executionStatus === "terminal").length,
      peakConcurrent: intervalsComplete ? peakConcurrent : null,
    },
  };
}
