/**
 * Persists subagent run records in the shared sqlite state database, with
 * query-bearing identity columns indexing canonical normalized payload JSON.
 */
import type { DatabaseSync } from "node:sqlite";
import { asFiniteNumber as normalizeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { sql, type ExpressionBuilder } from "kysely";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../../infra/sqlite-transaction.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { projectSubagentRunForMaintenance } from "./subagent-delivery-state.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import {
  bindSubagentRunRecord,
  DELIVERY_STATUSES,
  rowToSubagentRunRecord,
  type SubagentRunSqliteRow,
} from "./subagent-registry.store.codec.js";
import {
  hasParentStoreColumns,
  writeSubagentRunValuesInDatabase,
  type BoundSubagentRunRecord,
} from "./subagent-registry.store.kernel.js";
import type { SubagentRunMaintenanceRecord, SubagentRunRecord } from "./subagent-registry.types.js";
import { collectSubagentSessionReadKeys } from "./subagent-session-read-scope.js";

type SubagentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "subagent_runs">;
type SubagentRunReadSqliteRow = Pick<
  SubagentRunSqliteRow,
  | "run_id"
  | "child_session_key"
  | "controller_session_key"
  | "requester_session_key"
  | "controller_store_path"
  | "requester_store_path"
  | "created_at"
> & {
  model: string | null;
  task_run_id: string | null;
  swarm_run_id: string | null;
  run_timeout_seconds: number | null;
  execution_status: SubagentRunRecord["execution"]["status"];
  started_at: number | null;
  session_started_at: number | null;
  accumulated_runtime_ms: number | null;
  ended_at: number | null;
  ended_reason: string | null;
  cleanup_completed_at: number | null;
  generation: number | null;
  outcome_status: string | null;
  delivery_status: string | null;
  delivery_suspended_at: number | null;
  requester_agent_id: string | null;
  collect: number | null;
  group_id: string | null;
  swarm_requester_session_key: string | null;
  collector_status: NonNullable<SubagentRunRecord["collectorCompletion"]>["status"] | null;
};
function parentStoreColumns(db: DatabaseSync) {
  return hasParentStoreColumns(db)
    ? (["requester_store_path", "controller_store_path"] as const)
    : [
        sql.val<string | null>(null).as("requester_store_path"),
        sql.val<string | null>(null).as("controller_store_path"),
      ];
}

export function readSubagentRun(
  database: OpenClawStateDatabase,
  runId: string,
): SubagentRunRecord | null {
  const row = executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<SubagentRegistryDatabase>(database.db)
      .selectFrom("subagent_runs")
      .selectAll()
      .where("run_id", "=", runId),
  ).rows[0];
  return row ? rowToSubagentRunRecord(row) : null;
}

function writeSubagentRunValues(
  values: readonly BoundSubagentRunRecord[],
  deleteRunIds?: readonly string[],
  retainedRunIds?: readonly string[],
): void {
  if (values.length === 0 && deleteRunIds?.length === 0 && retainedRunIds === undefined) {
    return;
  }
  runOpenClawStateWriteTransaction((database) =>
    writeSubagentRunValuesInDatabase(database, values, deleteRunIds, retainedRunIds),
  );
}

type SubagentRegistryReadScope =
  | { kind: "controller"; sessionKey: string }
  | { kind: "session"; sessionKey: string }
  | { kind: "child"; sessionKey: string }
  | { kind: "runs"; runIds: readonly string[] };

function subagentControllerFilter(controllerSessionKeys: readonly string[]) {
  // The writer trims controller keys; older null/empty rows belong to their requester.
  return (eb: ExpressionBuilder<SubagentRegistryDatabase, "subagent_runs">) =>
    eb.or([
      eb("controller_session_key", "in", controllerSessionKeys),
      eb.and([
        eb.or([eb("controller_session_key", "is", null), eb("controller_session_key", "=", "")]),
        eb("requester_session_key", "in", controllerSessionKeys),
      ]),
    ]);
}

function readSubagentRegistryRows(
  scope?: SubagentRegistryReadScope,
  database: Pick<OpenClawStateDatabase, "db"> = openOpenClawStateDatabase(),
  projection: "full" | "maintenance" = "full",
): SubagentRunSqliteRow[] {
  const { db } = database;
  const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
  let query = stateDb
    .selectFrom("subagent_runs")
    .select([
      "run_id",
      "child_session_key",
      "controller_session_key",
      "requester_session_key",
      ...parentStoreColumns(db),
      "created_at",
    ])
    .select(projection === "full" ? "payload_json" : subagentMaintenancePayload.as("payload_json"));
  if (scope?.kind === "child") {
    query = query.where("child_session_key", "=", scope.sessionKey);
  } else if (scope?.kind === "runs") {
    query = query.where("run_id", "in", sqliteStringSet(scope.runIds));
  } else if (scope?.kind === "session") {
    query = query.where((eb) =>
      eb.or([
        eb("controller_session_key", "=", scope.sessionKey),
        eb("requester_session_key", "=", scope.sessionKey),
      ]),
    );
  } else if (scope?.kind === "controller") {
    query = query.where(subagentControllerFilter([scope.sessionKey]));
  }
  return executeSqliteQuerySync(db, query.orderBy("created_at", "asc").orderBy("run_id", "asc"))
    .rows;
}

function subagentPayloadJsonValue<T>(path: string) {
  return /* kysely-allow-raw: SQLite JSON1 projects bounded fields from the canonical payload column. */ sql<T>`json_extract(payload_json, ${path})`;
}

function canonicalSubagentPayloadFilter() {
  return /* kysely-allow-raw: Keep projection eligibility identical to the full canonical payload parser. */ sql<boolean>`json_valid(payload_json)
    AND json_type(payload_json, '$.execution') = 'object'
    AND json_extract(payload_json, '$.execution.status')
      IN ('queued', 'running', 'interrupted', 'terminal')
    AND json_type(payload_json, '$.completion') = 'object'
    AND json_type(payload_json, '$.completion.required') IN ('true', 'false')
    AND json_type(payload_json, '$.delivery') = 'object'
    AND json_extract(payload_json, '$.delivery.status')
      IN (
        'not_required',
        'pending',
        'in_progress',
        'delivered',
        'failed',
        'suspended',
        'discarded'
      )
    AND json_type(payload_json, '$.delivery.handoffLeaseId') IS NULL
    AND json_type(payload_json, '$.delivery.handoffLeasedAt') IS NULL
    AND json_type(payload_json, '$.delivery.handoffInjectedAt') IS NULL`;
}

const subagentRetainedPayloadPaths = [
  "$.task",
  "$.completion.resultText",
  "$.completion.fallbackResultText",
  "$.completion.terminalReply",
  "$.delivery.payload",
  "$.delivery.lastError",
  "$.execution.outcome.error",
  "$.collectorCompletion.structured",
  "$.collectorCompletion.schemaError",
  "$.outputSchema",
  "$.structuredOutput",
  "$.queuedLaunch",
];

const subagentMetadataPayload =
  /* kysely-allow-raw: Drop retained content without changing canonical eligibility or persisted bytes. */
  sql<string>`CASE WHEN json_valid(payload_json) THEN json_remove(
    CASE WHEN json_type(payload_json, '$.parentCompletion') = 'object'
      AND json_extract(payload_json, '$.parentCompletion.completionTarget') = 'parent'
      THEN json_extract(payload_json, '$.parentCompletion') ELSE payload_json END,
    ${sql.join(subagentRetainedPayloadPaths)}
  ) ELSE payload_json END`;

// Keep envelope selection with JSON.parse, whose duplicate-key semantics differ from JSON1.
// SQLite treats literal NUL as EOF; malformed/overdepth text must also reach the original parser.
const subagentMaintenancePayload =
  /* kysely-allow-raw: Preserve full-reader parsing while omitting unused retained payloads. */
  sql<string>`CASE WHEN json_valid(payload_json)
      AND length(CAST(payload_json AS BLOB)) = length(CAST(printf('%s', payload_json) AS BLOB))
    THEN json_remove(payload_json, ${sql.join(subagentRetainedPayloadPaths.flatMap((path) => [path, `$.parentCompletion${path.slice(1)}`]))})
    ELSE payload_json END`;

function readSubagentSessionListRows(
  scope?: { controllerSessionKeys?: readonly string[] },
  database: Pick<OpenClawStateDatabase, "db"> = openOpenClawStateDatabase(),
): SubagentRunReadSqliteRow[] {
  const { db } = database;
  const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
  return executeSqliteQuerySync(
    db,
    stateDb
      .with(
        (cte) => cte("canonical_runs").materialized(),
        (query) => {
          const selected = query.selectFrom("subagent_runs").select([
            "run_id",
            "child_session_key",
            "controller_session_key",
            "requester_session_key",
            ...parentStoreColumns(db),
            "created_at",
            // Materialize compact metadata once; an inline CTE repeats retained JSON work per field.
            subagentMetadataPayload.as("payload_json"),
          ]);
          return scope?.controllerSessionKeys
            ? selected.where(subagentControllerFilter(scope.controllerSessionKeys))
            : selected;
        },
      )
      .selectFrom("canonical_runs")
      .select([
        "run_id",
        "child_session_key",
        "controller_session_key",
        "requester_session_key",
        "requester_store_path",
        "controller_store_path",
        "created_at",
        subagentPayloadJsonValue<string | null>("$.swarmRunId").as("swarm_run_id"),
        subagentPayloadJsonValue<string | null>("$.taskRunId").as("task_run_id"),
        subagentPayloadJsonValue<string | null>("$.model").as("model"),
        subagentPayloadJsonValue<number | null>("$.collect").as("collect"),
        subagentPayloadJsonValue<string | null>("$.groupId").as("group_id"),
        subagentPayloadJsonValue<string | null>("$.swarmRequesterSessionKey").as(
          "swarm_requester_session_key",
        ),
        subagentPayloadJsonValue<string | null>("$.collectorCompletion.status").as(
          "collector_status",
        ),
        subagentPayloadJsonValue<number | null>("$.runTimeoutSeconds").as("run_timeout_seconds"),
        subagentPayloadJsonValue<SubagentRunRecord["execution"]["status"]>("$.execution.status").as(
          "execution_status",
        ),
        subagentPayloadJsonValue<number | null>("$.execution.startedAt").as("started_at"),
        subagentPayloadJsonValue<number | null>("$.sessionStartedAt").as("session_started_at"),
        subagentPayloadJsonValue<number | null>("$.accumulatedRuntimeMs").as(
          "accumulated_runtime_ms",
        ),
        subagentPayloadJsonValue<number | null>("$.execution.endedAt").as("ended_at"),
        subagentPayloadJsonValue<string | null>("$.endedReason").as("ended_reason"),
        subagentPayloadJsonValue<number | null>("$.cleanupCompletedAt").as("cleanup_completed_at"),
        subagentPayloadJsonValue<number | null>("$.generation").as("generation"),
        subagentPayloadJsonValue<string | null>("$.execution.outcome.status").as("outcome_status"),
        subagentPayloadJsonValue<string | null>("$.delivery.status").as("delivery_status"),
        subagentPayloadJsonValue<string | null>("$.requesterAgentId").as("requester_agent_id"),
        subagentPayloadJsonValue<number | null>("$.delivery.suspendedAt").as(
          "delivery_suspended_at",
        ),
      ])
      // Keep the projection aligned with the canonical full-registry row filter
      // without transferring and parsing the retained payload in JavaScript.
      .where(canonicalSubagentPayloadFilter())
      .orderBy("created_at", "asc")
      .orderBy("run_id", "asc"),
  ).rows as SubagentRunReadSqliteRow[];
}

function rowToSubagentRunReadRecord(row: SubagentRunReadSqliteRow): SubagentRunReadRecord | null {
  const runId = row.run_id.trim();
  const childSessionKey = row.child_session_key.trim();
  const requesterSessionKey = row.requester_session_key.trim();
  if (!runId || !childSessionKey || !requesterSessionKey) {
    return null;
  }
  const outcomeStatus =
    row.outcome_status === "ok" ||
    row.outcome_status === "error" ||
    row.outcome_status === "timeout" ||
    row.outcome_status === "unknown"
      ? row.outcome_status
      : undefined;
  const deliveryStatus = DELIVERY_STATUSES.has(row.delivery_status ?? "")
    ? (row.delivery_status as NonNullable<SubagentRunRecord["delivery"]>["status"])
    : undefined;
  const startedAt = normalizeFiniteNumber(row.started_at);
  const endedAt = normalizeFiniteNumber(row.ended_at);
  return Object.fromEntries(
    Object.entries({
      runId,
      taskRunId: row.task_run_id ?? undefined,
      swarmRunId: row.swarm_run_id || undefined,
      childSessionKey,
      controllerSessionKey: row.controller_session_key?.trim() || undefined,
      requesterSessionKey,
      requesterStorePath: row.requester_store_path ?? undefined,
      controllerStorePath: row.controller_store_path ?? undefined,
      requesterAgentId: row.requester_agent_id?.trim() || undefined,
      collect: row.collect === 1 ? true : undefined,
      groupId: row.group_id || undefined,
      swarmRequesterSessionKey: row.swarm_requester_session_key || undefined,
      collectorCompletion: row.collector_status ? { status: row.collector_status } : undefined,
      model: row.model || undefined,
      generation: normalizeFiniteNumber(row.generation),
      createdAt: row.created_at,
      execution: {
        status: row.execution_status,
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(endedAt !== undefined ? { endedAt } : {}),
        ...(outcomeStatus ? { outcome: { status: outcomeStatus } } : {}),
      },
      sessionStartedAt: normalizeFiniteNumber(row.session_started_at),
      accumulatedRuntimeMs: normalizeFiniteNumber(row.accumulated_runtime_ms),
      runTimeoutSeconds: normalizeFiniteNumber(row.run_timeout_seconds),
      endedReason: row.ended_reason || undefined,
      cleanupCompletedAt: normalizeFiniteNumber(row.cleanup_completed_at),
      delivery: deliveryStatus
        ? {
            status: deliveryStatus,
            ...(normalizeFiniteNumber(row.delivery_suspended_at) !== undefined
              ? { suspendedAt: row.delivery_suspended_at ?? undefined }
              : {}),
          }
        : undefined,
    }).filter(([, value]) => value !== undefined),
  ) as SubagentRunReadRecord;
}

function loadScopedSubagentRuns(
  scope: SubagentRegistryReadScope,
  database?: Pick<OpenClawStateDatabase, "db">,
): SubagentRunRecord[] {
  const normalizedScope =
    scope.kind === "runs" ? scope : { ...scope, sessionKey: scope.sessionKey.trim() };
  if (
    normalizedScope.kind === "runs"
      ? normalizedScope.runIds.length === 0
      : !normalizedScope.sessionKey
  ) {
    return [];
  }
  return readSubagentRegistryRows(normalizedScope, database).flatMap((row) => {
    const run = rowToSubagentRunRecord(row);
    return run ? [run] : [];
  });
}

/** Loads runs controlled by one session, preserving the legacy requester fallback. */
export function loadSubagentRunsForControllerFromSqlite(
  controllerSessionKey: string,
): SubagentRunRecord[] {
  return loadScopedSubagentRuns({ kind: "controller", sessionKey: controllerSessionKey });
}

/** Loads all generations readable by one requester or controller session. */
export function loadSubagentRunsForSessionFromSqlite(
  sessionKey: string,
  database?: Pick<OpenClawStateDatabase, "db">,
): SubagentRunRecord[] {
  return loadScopedSubagentRuns({ kind: "session", sessionKey }, database);
}

/** Loads all persisted generations for one child session through its existing index. */
export function loadSubagentRunsForChildSessionFromSqlite(
  childSessionKey: string,
  database?: Pick<OpenClawStateDatabase, "db">,
): SubagentRunRecord[] {
  return loadScopedSubagentRuns({ kind: "child", sessionKey: childSessionKey }, database);
}

/** Hydrates exact physical rows selected by the shared registry read projection. */
export function loadSubagentRunsByRunIdsFromSqlite(
  runIds: readonly string[],
  database?: Pick<OpenClawStateDatabase, "db">,
): SubagentRunRecord[] {
  return loadScopedSubagentRuns({ kind: "runs", runIds }, database);
}

/** Loads the canonical subagent registry from shared SQLite state. */
export function loadSubagentRegistryFromSqlite(): Map<string, SubagentRunRecord> {
  // Retired file-era runs are intentionally not recovered here: after SQLite
  // pruning, the file cannot prove whether a run is live or stale. Doctor owns discard.
  const runs = new Map<string, SubagentRunRecord>();
  for (const row of readSubagentRegistryRows()) {
    const entry = rowToSubagentRunRecord(row);
    if (entry) {
      runs.set(entry.runId, entry);
    }
  }
  return runs;
}

/** Uses the canonical codec without transferring retained prompts and completion results. */
export function loadSubagentMaintenanceRunsFromSqlite(): Map<string, SubagentRunMaintenanceRecord> {
  const runs = new Map<string, SubagentRunMaintenanceRecord>();
  for (const row of readSubagentRegistryRows(undefined, undefined, "maintenance")) {
    const entry = rowToSubagentRunRecord(row);
    if (entry) {
      runs.set(entry.runId, projectSubagentRunForMaintenance(entry));
    }
  }
  return runs;
}

/** Loads only the canonical fields needed to build session-list topology metadata. */
export function loadSubagentSessionListRunsFromSqlite(
  controllerSessionKeys?: readonly string[],
  database?: Pick<OpenClawStateDatabase, "db">,
): Map<string, SubagentRunReadRecord> {
  const runs = new Map<string, SubagentRunReadRecord>();
  const keys = controllerSessionKeys?.map((key) => key.trim()).filter(Boolean);
  if (keys?.length === 0) {
    return runs;
  }
  for (const row of readSubagentSessionListRows({ controllerSessionKeys: keys }, database)) {
    const entry = rowToSubagentRunReadRecord(row);
    if (entry) {
      runs.set(entry.runId, entry);
    }
  }
  return runs;
}

/** Select identities and their records from the same persisted read snapshot. */
export function loadSubagentRunsForSessionsFromSqlite(
  sessionKeys: readonly string[],
  inMemoryRuns: Iterable<SubagentRunReadRecord>,
): { sessionKeys: Set<string>; runs: Map<string, SubagentRunRecord>; complete: boolean } {
  const database = openOpenClawStateDatabase();
  const { db } = database;
  return runSqliteDeferredTransactionSync(db, () => {
    const identities = executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<SubagentRegistryDatabase>(db)
        .selectFrom("subagent_runs")
        .select(["run_id", "child_session_key", "requester_session_key"]),
    ).rows;
    const selected = collectSubagentSessionReadKeys(
      sessionKeys,
      identities.map((row) => ({
        childSessionKey: row.child_session_key,
        requesterSessionKey: row.requester_session_key,
      })),
      inMemoryRuns,
    );
    // Include physical rows that decode to the same run ID, even outside the
    // selected tree, so the codec's ordered replacement cannot resurrect a row.
    const selectedRunIds = new Set(
      identities
        .filter((row) => selected.has(row.child_session_key.trim()))
        .map((row) => row.run_id.trim()),
    );
    const runIds = identities
      .filter((row) => selectedRunIds.has(row.run_id.trim()))
      .map((row) => row.run_id);
    const runs = new Map<string, SubagentRunRecord>();
    // Only complete physical coverage may seed the full-record cache.
    const complete = runIds.length === identities.length;
    if (runIds.length) {
      for (const row of readSubagentRegistryRows(
        complete ? undefined : { kind: "runs", runIds },
        database,
      )) {
        const entry = rowToSubagentRunRecord(row);
        if (entry) {
          runs.set(entry.runId, entry);
        }
      }
    }
    return { sessionKeys: selected, runs, complete };
  });
}

/** Saves the complete subagent run snapshot to sqlite and prunes rows not in the snapshot. */
export function saveSubagentRegistryToSqlite(runs: Map<string, SubagentRunRecord>): void {
  const values = [...runs.values()].map(bindSubagentRunRecord);
  writeSubagentRunValues(
    values,
    undefined,
    values.map((row) => row.run_id),
  );
}

/** Persists only named run mutations, deleting names absent from the current registry. */
export function saveSubagentRegistryChangesToSqlite(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[],
): void {
  const runIds = [...new Set(changedRunIds.map((runId) => runId.trim()).filter(Boolean))];
  const values: BoundSubagentRunRecord[] = [];
  const deleteRunIds: string[] = [];
  for (const runId of runIds) {
    const entry = runs.get(runId);
    if (entry) {
      values.push(bindSubagentRunRecord(entry));
    } else {
      deleteRunIds.push(runId);
    }
  }
  writeSubagentRunValues(values, deleteRunIds);
}

/** Mutation ownership cannot discard undecodable retained rows as presentation readers do. */
export function hasSubagentSessionOwnerInDatabase(
  database: Pick<OpenClawStateDatabase, "db">,
  sessionKey: string,
): boolean {
  return (
    executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<SubagentRegistryDatabase>(database.db)
        .selectFrom("subagent_runs")
        .select("run_id")
        .where((eb) =>
          eb.or([
            eb("child_session_key", "=", sessionKey),
            eb("requester_session_key", "=", sessionKey),
            eb("controller_session_key", "=", sessionKey),
          ]),
        )
        .limit(1),
    ).rows.length > 0
  );
}
