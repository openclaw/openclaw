import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile } from "../infra/json-file.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { readStringValue } from "../shared/string-coerce.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  type OpenClawStateDatabaseOptions,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type SubagentRunsTable = OpenClawStateKyselyDatabase["subagent_runs"];
type SubagentRunRow = Selectable<SubagentRunsTable>;
type SubagentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "subagent_runs">;

type PersistedSubagentRegistryV1 = {
  version: 1;
  runs: Record<string, LegacySubagentRunRecord>;
};

type PersistedSubagentRegistryV2 = {
  version: 2;
  runs: Record<string, PersistedSubagentRunRecord>;
};

type PersistedSubagentRegistry = PersistedSubagentRegistryV1 | PersistedSubagentRegistryV2;

type PersistedSubagentRunRecord = SubagentRunRecord;

type LegacySubagentRunRecord = PersistedSubagentRunRecord & {
  announceCompletedAt?: unknown;
  announceHandled?: unknown;
  requesterChannel?: unknown;
  requesterAccountId?: unknown;
};

function resolveSubagentStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) {
    return resolveStateDir(env);
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), "openclaw-test-state", String(process.pid));
  }
  return resolveStateDir(env);
}

export function resolveLegacySubagentRegistryPath(): string {
  return path.join(resolveSubagentStateDir(process.env), "subagents", "runs.json");
}

function resolveLegacySubagentRegistryPathForEnv(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSubagentStateDir(env), "subagents", "runs.json");
}

function subagentRegistryDbOptions(
  env: NodeJS.ProcessEnv = process.env,
): OpenClawStateDatabaseOptions {
  return {
    env: {
      ...env,
      OPENCLAW_STATE_DIR: resolveSubagentStateDir(env),
    },
  };
}

function normalizePersistedRunRecords(params: {
  runsRaw: Record<string, unknown>;
  isLegacy: boolean;
}): Map<string, SubagentRunRecord> {
  const out = new Map<string, SubagentRunRecord>();
  for (const [runId, entry] of Object.entries(params.runsRaw)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const typed = entry as LegacySubagentRunRecord;
    if (!typed.runId || typeof typed.runId !== "string") {
      continue;
    }
    const legacyCompletedAt =
      params.isLegacy && typeof typed.announceCompletedAt === "number"
        ? typed.announceCompletedAt
        : undefined;
    const cleanupCompletedAt =
      typeof typed.cleanupCompletedAt === "number" ? typed.cleanupCompletedAt : legacyCompletedAt;
    const cleanupHandled =
      typeof typed.cleanupHandled === "boolean"
        ? typed.cleanupHandled
        : params.isLegacy
          ? Boolean(typed.announceHandled ?? cleanupCompletedAt)
          : undefined;
    const requesterOrigin = normalizeDeliveryContext(
      typed.requesterOrigin ?? {
        channel: readStringValue(typed.requesterChannel),
        accountId: readStringValue(typed.requesterAccountId),
      },
    );
    const childSessionKey = readStringValue(typed.childSessionKey)?.trim() ?? "";
    const requesterSessionKey = readStringValue(typed.requesterSessionKey)?.trim() ?? "";
    const controllerSessionKey =
      readStringValue(typed.controllerSessionKey)?.trim() || requesterSessionKey;
    if (!childSessionKey || !requesterSessionKey) {
      continue;
    }
    const {
      announceCompletedAt: _announceCompletedAt,
      announceHandled: _announceHandled,
      requesterChannel: _channel,
      requesterAccountId: _accountId,
      ...rest
    } = typed;
    out.set(runId, {
      ...rest,
      childSessionKey,
      requesterSessionKey,
      controllerSessionKey,
      requesterOrigin,
      cleanupCompletedAt,
      cleanupHandled,
      spawnMode: typed.spawnMode === "session" ? "session" : "run",
    });
  }
  return out;
}

function getSubagentRegistryKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<SubagentRegistryDatabase>(db);
}

function serializeJson(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- JSON columns are parsed at module boundaries.
function parseJsonValue<T>(raw: string | null): T | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function normalizeNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

function normalizeBoolean(value: number | bigint | null): boolean | undefined {
  if (typeof value === "bigint") {
    return value !== 0n;
  }
  return typeof value === "number" ? value !== 0 : undefined;
}

function booleanToInteger(value: boolean | undefined): number | null {
  return typeof value === "boolean" ? (value ? 1 : 0) : null;
}

function rowToRunRecord(row: SubagentRunRow): SubagentRunRecord | null {
  const payload = parseJsonValue<Partial<SubagentRunRecord>>(row.payload_json) ?? {};
  const raw: PersistedSubagentRunRecord = {
    ...payload,
    runId: row.run_id,
    childSessionKey: row.child_session_key,
    controllerSessionKey: row.controller_session_key ?? undefined,
    requesterSessionKey: row.requester_session_key,
    requesterDisplayKey: row.requester_display_key,
    requesterOrigin: parseJsonValue<DeliveryContext>(row.requester_origin_json),
    task: row.task,
    cleanup: row.cleanup === "delete" ? "delete" : "keep",
    label: row.label ?? undefined,
    model: row.model ?? undefined,
    agentDir: row.agent_dir ?? undefined,
    workspaceDir: row.workspace_dir ?? undefined,
    runTimeoutSeconds: normalizeNumber(row.run_timeout_seconds),
    spawnMode: row.spawn_mode === "session" ? "session" : "run",
    createdAt: normalizeNumber(row.created_at) ?? 0,
    startedAt: normalizeNumber(row.started_at),
    sessionStartedAt: normalizeNumber(row.session_started_at),
    accumulatedRuntimeMs: normalizeNumber(row.accumulated_runtime_ms),
    endedAt: normalizeNumber(row.ended_at),
    outcome: parseJsonValue<SubagentRunOutcome>(row.outcome_json),
    archiveAtMs: normalizeNumber(row.archive_at_ms),
    cleanupCompletedAt: normalizeNumber(row.cleanup_completed_at),
    cleanupHandled: normalizeBoolean(row.cleanup_handled),
    suppressAnnounceReason:
      row.suppress_announce_reason === "steer-restart" || row.suppress_announce_reason === "killed"
        ? row.suppress_announce_reason
        : undefined,
    expectsCompletionMessage: normalizeBoolean(row.expects_completion_message),
    announceRetryCount: normalizeNumber(row.announce_retry_count),
    lastAnnounceRetryAt: normalizeNumber(row.last_announce_retry_at),
    lastAnnounceDeliveryError: row.last_announce_delivery_error ?? undefined,
    endedReason: row.ended_reason as SubagentRunRecord["endedReason"],
    pauseReason: row.pause_reason === "sessions_yield" ? "sessions_yield" : undefined,
    wakeOnDescendantSettle: normalizeBoolean(row.wake_on_descendant_settle),
    frozenResultText: row.frozen_result_text ?? undefined,
    frozenResultCapturedAt: normalizeNumber(row.frozen_result_captured_at),
    fallbackFrozenResultText: row.fallback_frozen_result_text ?? undefined,
    fallbackFrozenResultCapturedAt: normalizeNumber(row.fallback_frozen_result_captured_at),
    endedHookEmittedAt: normalizeNumber(row.ended_hook_emitted_at),
    pendingFinalDelivery: normalizeBoolean(row.pending_final_delivery),
    pendingFinalDeliveryCreatedAt: normalizeNumber(row.pending_final_delivery_created_at),
    pendingFinalDeliveryLastAttemptAt: normalizeNumber(row.pending_final_delivery_last_attempt_at),
    pendingFinalDeliveryAttemptCount: normalizeNumber(row.pending_final_delivery_attempt_count),
    pendingFinalDeliveryLastError: row.pending_final_delivery_last_error,
    pendingFinalDeliveryPayload: parseJsonValue(row.pending_final_delivery_payload_json),
    completionAnnouncedAt: normalizeNumber(row.completion_announced_at),
    attachmentsDir: row.attachments_dir ?? undefined,
    attachmentsRootDir: row.attachments_root_dir ?? undefined,
    retainAttachmentsOnKeep: normalizeBoolean(row.retain_attachments_on_keep),
  };
  return (
    normalizePersistedRunRecords({
      runsRaw: { [raw.runId]: raw },
      isLegacy: false,
    }).get(raw.runId) ?? null
  );
}

function runRecordToRow(record: SubagentRunRecord): Insertable<SubagentRunsTable> {
  return {
    run_id: record.runId,
    child_session_key: record.childSessionKey,
    controller_session_key: record.controllerSessionKey ?? null,
    requester_session_key: record.requesterSessionKey,
    requester_display_key: record.requesterDisplayKey,
    requester_origin_json: serializeJson(record.requesterOrigin),
    task: record.task,
    cleanup: record.cleanup,
    label: record.label ?? null,
    model: record.model ?? null,
    agent_dir: record.agentDir ?? null,
    workspace_dir: record.workspaceDir ?? null,
    run_timeout_seconds: record.runTimeoutSeconds ?? null,
    spawn_mode: record.spawnMode ?? "run",
    created_at: record.createdAt,
    started_at: record.startedAt ?? null,
    session_started_at: record.sessionStartedAt ?? null,
    accumulated_runtime_ms: record.accumulatedRuntimeMs ?? null,
    ended_at: record.endedAt ?? null,
    outcome_json: serializeJson(record.outcome),
    archive_at_ms: record.archiveAtMs ?? null,
    cleanup_completed_at: record.cleanupCompletedAt ?? null,
    cleanup_handled: booleanToInteger(record.cleanupHandled),
    suppress_announce_reason: record.suppressAnnounceReason ?? null,
    expects_completion_message: booleanToInteger(record.expectsCompletionMessage),
    announce_retry_count: record.announceRetryCount ?? null,
    last_announce_retry_at: record.lastAnnounceRetryAt ?? null,
    last_announce_delivery_error: record.lastAnnounceDeliveryError ?? null,
    ended_reason: record.endedReason ?? null,
    pause_reason: record.pauseReason ?? null,
    wake_on_descendant_settle: booleanToInteger(record.wakeOnDescendantSettle),
    frozen_result_text: record.frozenResultText ?? null,
    frozen_result_captured_at: record.frozenResultCapturedAt ?? null,
    fallback_frozen_result_text: record.fallbackFrozenResultText ?? null,
    fallback_frozen_result_captured_at: record.fallbackFrozenResultCapturedAt ?? null,
    ended_hook_emitted_at: record.endedHookEmittedAt ?? null,
    pending_final_delivery: booleanToInteger(record.pendingFinalDelivery),
    pending_final_delivery_created_at: record.pendingFinalDeliveryCreatedAt ?? null,
    pending_final_delivery_last_attempt_at: record.pendingFinalDeliveryLastAttemptAt ?? null,
    pending_final_delivery_attempt_count: record.pendingFinalDeliveryAttemptCount ?? null,
    pending_final_delivery_last_error: record.pendingFinalDeliveryLastError ?? null,
    pending_final_delivery_payload_json: serializeJson(record.pendingFinalDeliveryPayload),
    completion_announced_at: record.completionAnnouncedAt ?? null,
    attachments_dir: record.attachmentsDir ?? null,
    attachments_root_dir: record.attachmentsRootDir ?? null,
    retain_attachments_on_keep: booleanToInteger(record.retainAttachmentsOnKeep),
    payload_json: JSON.stringify(record),
  };
}

function upsertSubagentRunRow(db: DatabaseSync, row: Insertable<SubagentRunsTable>): void {
  executeSqliteQuerySync(
    db,
    getSubagentRegistryKysely(db)
      .insertInto("subagent_runs")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("run_id").doUpdateSet({
          child_session_key: (eb) => eb.ref("excluded.child_session_key"),
          controller_session_key: (eb) => eb.ref("excluded.controller_session_key"),
          requester_session_key: (eb) => eb.ref("excluded.requester_session_key"),
          requester_display_key: (eb) => eb.ref("excluded.requester_display_key"),
          requester_origin_json: (eb) => eb.ref("excluded.requester_origin_json"),
          task: (eb) => eb.ref("excluded.task"),
          cleanup: (eb) => eb.ref("excluded.cleanup"),
          label: (eb) => eb.ref("excluded.label"),
          model: (eb) => eb.ref("excluded.model"),
          agent_dir: (eb) => eb.ref("excluded.agent_dir"),
          workspace_dir: (eb) => eb.ref("excluded.workspace_dir"),
          run_timeout_seconds: (eb) => eb.ref("excluded.run_timeout_seconds"),
          spawn_mode: (eb) => eb.ref("excluded.spawn_mode"),
          created_at: (eb) => eb.ref("excluded.created_at"),
          started_at: (eb) => eb.ref("excluded.started_at"),
          session_started_at: (eb) => eb.ref("excluded.session_started_at"),
          accumulated_runtime_ms: (eb) => eb.ref("excluded.accumulated_runtime_ms"),
          ended_at: (eb) => eb.ref("excluded.ended_at"),
          outcome_json: (eb) => eb.ref("excluded.outcome_json"),
          archive_at_ms: (eb) => eb.ref("excluded.archive_at_ms"),
          cleanup_completed_at: (eb) => eb.ref("excluded.cleanup_completed_at"),
          cleanup_handled: (eb) => eb.ref("excluded.cleanup_handled"),
          suppress_announce_reason: (eb) => eb.ref("excluded.suppress_announce_reason"),
          expects_completion_message: (eb) => eb.ref("excluded.expects_completion_message"),
          announce_retry_count: (eb) => eb.ref("excluded.announce_retry_count"),
          last_announce_retry_at: (eb) => eb.ref("excluded.last_announce_retry_at"),
          last_announce_delivery_error: (eb) => eb.ref("excluded.last_announce_delivery_error"),
          ended_reason: (eb) => eb.ref("excluded.ended_reason"),
          pause_reason: (eb) => eb.ref("excluded.pause_reason"),
          wake_on_descendant_settle: (eb) => eb.ref("excluded.wake_on_descendant_settle"),
          frozen_result_text: (eb) => eb.ref("excluded.frozen_result_text"),
          frozen_result_captured_at: (eb) => eb.ref("excluded.frozen_result_captured_at"),
          fallback_frozen_result_text: (eb) => eb.ref("excluded.fallback_frozen_result_text"),
          fallback_frozen_result_captured_at: (eb) =>
            eb.ref("excluded.fallback_frozen_result_captured_at"),
          ended_hook_emitted_at: (eb) => eb.ref("excluded.ended_hook_emitted_at"),
          pending_final_delivery: (eb) => eb.ref("excluded.pending_final_delivery"),
          pending_final_delivery_created_at: (eb) =>
            eb.ref("excluded.pending_final_delivery_created_at"),
          pending_final_delivery_last_attempt_at: (eb) =>
            eb.ref("excluded.pending_final_delivery_last_attempt_at"),
          pending_final_delivery_attempt_count: (eb) =>
            eb.ref("excluded.pending_final_delivery_attempt_count"),
          pending_final_delivery_last_error: (eb) =>
            eb.ref("excluded.pending_final_delivery_last_error"),
          pending_final_delivery_payload_json: (eb) =>
            eb.ref("excluded.pending_final_delivery_payload_json"),
          completion_announced_at: (eb) => eb.ref("excluded.completion_announced_at"),
          attachments_dir: (eb) => eb.ref("excluded.attachments_dir"),
          attachments_root_dir: (eb) => eb.ref("excluded.attachments_root_dir"),
          retain_attachments_on_keep: (eb) => eb.ref("excluded.retain_attachments_on_keep"),
          payload_json: (eb) => eb.ref("excluded.payload_json"),
        }),
      ),
  );
}

export function loadSubagentRegistryFromSqlite(
  env: NodeJS.ProcessEnv = process.env,
): Map<string, SubagentRunRecord> | null {
  const database = openOpenClawStateDatabase(subagentRegistryDbOptions(env));
  const query = getSubagentRegistryKysely(database.db)
    .selectFrom("subagent_runs")
    .selectAll()
    .orderBy("created_at", "asc")
    .orderBy("run_id", "asc");
  const rows = executeSqliteQuerySync<SubagentRunRow>(database.db, query).rows;
  if (rows.length === 0) {
    return null;
  }
  const runs = new Map<string, SubagentRunRecord>();
  for (const row of rows) {
    const run = rowToRunRecord(row);
    if (run) {
      runs.set(run.runId, run);
    }
  }
  return runs;
}

export function loadSubagentRegistryFromState(): Map<string, SubagentRunRecord> {
  return loadSubagentRegistryFromSqlite() ?? new Map();
}

function writeSubagentRegistryRunsToSqlite(
  runs: Map<string, SubagentRunRecord>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  runOpenClawStateWriteTransaction((database) => {
    for (const entry of runs.values()) {
      upsertSubagentRunRow(database.db, runRecordToRow(entry));
    }
  }, subagentRegistryDbOptions(env));
}

function loadLegacySubagentRegistryFile(pathname: string): Map<string, SubagentRunRecord> {
  const raw = loadJsonFile(pathname);
  if (!raw || typeof raw !== "object") {
    return new Map();
  }
  const record = raw as Partial<PersistedSubagentRegistry>;
  if (record.version !== 1 && record.version !== 2) {
    return new Map();
  }
  const runsRaw = record.runs;
  if (!runsRaw || typeof runsRaw !== "object") {
    return new Map();
  }
  return normalizePersistedRunRecords({
    runsRaw: runsRaw as Record<string, unknown>,
    isLegacy: record.version === 1,
  });
}

export function legacySubagentRegistryFileExists(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return fs.statSync(resolveLegacySubagentRegistryPathForEnv(env)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function importLegacySubagentRegistryFileToSqlite(env: NodeJS.ProcessEnv = process.env): {
  imported: boolean;
  runs: number;
} {
  const pathname = resolveLegacySubagentRegistryPathForEnv(env);
  if (!legacySubagentRegistryFileExists(env)) {
    return { imported: false, runs: 0 };
  }
  const runs = loadLegacySubagentRegistryFile(pathname);
  writeSubagentRegistryRunsToSqlite(runs, env);
  try {
    fs.unlinkSync(pathname);
  } catch {
    // Import succeeded; a later doctor pass can remove the stale file.
  }
  return { imported: true, runs: runs.size };
}

export function saveSubagentRegistryToState(runs: Map<string, SubagentRunRecord>) {
  runOpenClawStateWriteTransaction((database) => {
    const kysely = getSubagentRegistryKysely(database.db);
    const existing = executeSqliteQuerySync<{ run_id: string }>(
      database.db,
      kysely.selectFrom("subagent_runs").select("run_id"),
    ).rows;
    for (const entry of existing) {
      if (!runs.has(entry.run_id)) {
        executeSqliteQuerySync(
          database.db,
          kysely.deleteFrom("subagent_runs").where("run_id", "=", entry.run_id),
        );
      }
    }
    for (const entry of runs.values()) {
      upsertSubagentRunRow(database.db, runRecordToRow(entry));
    }
  }, subagentRegistryDbOptions());
}
