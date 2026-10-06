import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sql, type ExpressionBuilder, type RawBuilder } from "kysely";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../../infra/sqlite-transaction.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import {
  isSettledSubagentRequesterHistory,
  projectSubagentRunForMaintenance,
  projectSubagentRunForSessionList,
} from "./subagent-delivery-state.js";
import type {
  SubagentRunReadRecord,
  SubagentMaintenanceDurableBasis,
  SubagentRunsDurableBasis,
} from "./subagent-registry-read.types.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import { hasParentStoreColumns } from "./subagent-registry.store.kernel.js";
import { subagentRunRowVersion, type SubagentRunSqliteRow } from "./subagent-registry.store.row.js";
import type { SubagentRunMaintenanceRecord, SubagentRunRecord } from "./subagent-registry.types.js";
import { collectSubagentSessionReadKeys } from "./subagent-session-read-scope.js";

type SubagentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "subagent_runs">;
function parentStoreColumns(db: DatabaseSync) {
  return hasParentStoreColumns(db)
    ? (["requester_store_path", "controller_store_path"] as const)
    : [
        sql.val<string | null>(null).as("requester_store_path"),
        sql.val<string | null>(null).as("controller_store_path"),
      ];
}

export function readSubagentRunRow(
  database: Pick<OpenClawStateDatabase, "db">,
  runId: string,
): SubagentRunSqliteRow | undefined {
  return executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<SubagentRegistryDatabase>(database.db)
      .selectFrom("subagent_runs")
      .selectAll()
      .where("run_id", "=", runId),
  ).rows[0];
}

export function readSubagentRun(
  database: OpenClawStateDatabase,
  runId: string,
): SubagentRunRecord | null {
  const row = readSubagentRunRow(database, runId);
  return row ? rowToSubagentRunRecord(row) : null;
}

type SubagentRegistryReadScope =
  | { kind: "session"; sessionKey: string }
  | { kind: "child"; sessionKey: string }
  | { kind: "children"; sessionKeys: readonly string[] }
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
  scope: SubagentRegistryReadScope | undefined,
  database: Pick<OpenClawStateDatabase, "db">,
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
  } else if (scope?.kind === "children") {
    query = query.where("child_session_key", "in", sqliteStringSet(scope.sessionKeys));
  } else if (scope?.kind === "runs") {
    query = query.where("run_id", "in", sqliteStringSet(scope.runIds));
  } else if (scope?.kind === "session") {
    query = query.where((eb) =>
      eb.or([
        eb("controller_session_key", "=", scope.sessionKey),
        eb("requester_session_key", "=", scope.sessionKey),
      ]),
    );
  }
  return executeSqliteQuerySync(db, query.orderBy("created_at", "asc").orderBy("run_id", "asc"))
    .rows;
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

// Keep duplicate envelopes for JSON.parse. The byte-length check rejects literal NUL
// without instr's character-by-character scan of every retained result.
const subagentMetadataPayload =
  /* kysely-allow-raw: omit retained bodies without selecting the first duplicate envelope. */
  sql<string | null>`CASE WHEN json_valid(payload_json)
      AND length(CAST(payload_json AS BLOB)) = length(CAST(printf('%s', payload_json) AS BLOB))
    THEN json_remove(payload_json, ${sql.join(subagentRetainedPayloadPaths.flatMap((path) => [path, `$.parentCompletion${path.slice(1)}`]))})
    ELSE NULL END`;

// Maintenance must send malformed/overdepth text to the original parser.
const subagentMaintenancePayload =
  /* kysely-allow-raw: preserve full-reader parsing when SQLite cannot trim the payload. */
  sql<string>`COALESCE(${subagentMetadataPayload}, payload_json)`;

const subagentSessionListPaths = [
  "completionTarget",
  "swarmRunId",
  "schedulerSlotId",
  "swarmLaunchReplayKey",
  "taskRunId",
  "model",
  "pauseReason",
  "collect",
  "groupId",
  "swarmRequesterSessionKey",
  "collectorCompletion.status",
  "runTimeoutSeconds",
  "execution.status",
  "execution.interruptionReason",
  "execution.startedAt",
  "execution.endedAt",
  "execution.outcome.status",
  "completion.required",
  "delivery.status",
  "delivery.disposition",
  "delivery.suspendedAt",
  "delivery.handoffLeaseId",
  "delivery.handoffLeasedAt",
  "delivery.handoffInjectedAt",
  "childAgentId",
  "requesterAgentId",
  "sessionStartedAt",
  "accumulatedRuntimeMs",
  "endedReason",
  "cleanupCompletedAt",
  "generation",
  "createdAt",
  "expectsCompletionMessage",
];

function projectSessionListJsonMembers(
  payload: RawBuilder<unknown>,
  paths: readonly string[],
  depth: number,
): RawBuilder<string> {
  const members = new Map<string, string[]>();
  for (const path of paths) {
    const separator = path.indexOf(".");
    const key = separator < 0 ? path : path.slice(0, separator);
    const children = members.get(key) ?? [];
    if (separator >= 0) {
      children.push(path.slice(separator + 1));
    }
    members.set(key, children);
  }
  const alias = `member_${depth}`;
  const key =
    /* kysely-allow-raw: depth aliases belong to this static metadata projection. */ sql.ref(
      `${alias}.key`,
    );
  const type =
    /* kysely-allow-raw: depth aliases belong to this static metadata projection. */ sql.ref(
      `${alias}.type`,
    );
  const value =
    /* kysely-allow-raw: depth aliases belong to this static metadata projection. */ sql.ref(
      `${alias}.value`,
    );
  const cursor =
    /* kysely-allow-raw: this recursive projection owns every generated alias. */ sql.id(alias);
  const nested = [...members].flatMap(([name, children]) =>
    children.length
      ? [
          sql`WHEN ${key} = ${name} AND ${type} = 'object' THEN json(${projectSessionListJsonMembers(value, children, depth + 1)})`,
        ]
      : [],
  );
  // JSON.parse owns last-key selection. Scalar leaves retain invalid container types, not bodies.
  return /* kysely-allow-raw: bounded registry metadata excludes every retained body, including duplicated envelopes. */ sql<string>`(SELECT json_group_object(${key}, CASE
    ${sql.join(nested, sql` `)}
    WHEN ${type} = 'object' THEN json('{}') WHEN ${type} = 'array' THEN json('[]')
    WHEN ${type} = 'true' THEN json('true') WHEN ${type} = 'false' THEN json('false')
    ELSE ${value} END)
    FROM json_each(${payload}) AS ${cursor}
    WHERE ${key} IN (${sql.join([...members.keys()])}))`;
}

const subagentSessionListPayload = projectSessionListJsonMembers(
  /* kysely-allow-raw: fixed column in the materialized registry metadata relation. */ sql.ref(
    "payload_json",
  ),
  [
    ...subagentSessionListPaths,
    ...subagentSessionListPaths.map((path) => `parentCompletion.${path}`),
  ],
  0,
);

function readSubagentSessionListRows(
  scope: { controllerSessionKeys?: readonly string[] },
  database: Pick<OpenClawStateDatabase, "db">,
) {
  const { db } = database;
  const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
  return executeSqliteQuerySync(
    db,
    stateDb
      .with(
        (cte) => cte("metadata_runs").materialized(),
        (query) => {
          const selected = query
            .selectFrom("subagent_runs")
            .select([
              "run_id",
              "child_session_key",
              "controller_session_key",
              "requester_session_key",
              ...parentStoreColumns(db),
              "created_at",
              subagentMetadataPayload.as("payload_json"),
            ]);
          return scope.controllerSessionKeys
            ? selected.where(subagentControllerFilter(scope.controllerSessionKeys))
            : selected;
        },
      )
      .selectFrom("metadata_runs")
      .select([
        "run_id",
        "child_session_key",
        "controller_session_key",
        "requester_session_key",
        "requester_store_path",
        "controller_store_path",
        "created_at",
        subagentSessionListPayload.as("payload_json"),
      ])
      .where(
        /* kysely-allow-raw: malformed payloads cannot enter JSON member projection. */ sql<boolean>`json_valid(payload_json) AND json_type(payload_json) = 'object'`,
      )
      .orderBy("created_at", "asc")
      .orderBy("run_id", "asc"),
  ).rows;
}

function loadScopedSubagentRuns(
  scope: Extract<SubagentRegistryReadScope, { kind: "session" | "child" }>,
  database: Pick<OpenClawStateDatabase, "db">,
): SubagentRunRecord[] {
  const normalizedScope = { ...scope, sessionKey: scope.sessionKey.trim() };
  if (!normalizedScope.sessionKey) {
    return [];
  }
  return readSubagentRegistryRows(normalizedScope, database).flatMap((row) => {
    const run = rowToSubagentRunRecord(row);
    return run ? [run] : [];
  });
}

export function loadSubagentRunsForSessionFromSqlite(
  sessionKey: string,
  database: Pick<OpenClawStateDatabase, "db">,
): SubagentRunRecord[] {
  return loadScopedSubagentRuns({ kind: "session", sessionKey }, database);
}

export function loadSubagentRunsForChildSessionFromSqlite(
  childSessionKey: string,
  database: Pick<OpenClawStateDatabase, "db">,
): SubagentRunRecord[] {
  return loadScopedSubagentRuns({ kind: "child", sessionKey: childSessionKey }, database);
}

/** Raw versions accompany decoded values, so normalization cannot hide a foreign write. */
export function loadVersionedSubagentRunsInDatabase(
  database: Pick<OpenClawStateDatabase, "db">,
  runIds: readonly string[],
): { runs: Map<string, SubagentRunRecord>; versions: Map<string, string | null> } {
  const versions = new Map<string, string | null>(runIds.map((runId) => [runId, null]));
  const runs = decodeSubagentRegistryRows(
    runIds.length === 0 ? [] : readSubagentRegistryRows({ kind: "runs", runIds }, database),
    (entry) => entry,
    (row) => versions.set(row.run_id, subagentRunRowVersion(row)),
  );
  return { runs, versions };
}

function decodeSubagentRegistryRows<T>(
  rows: Iterable<SubagentRunSqliteRow>,
  project: (entry: SubagentRunRecord) => T,
  observe?: (row: SubagentRunSqliteRow) => void,
): Map<string, T> {
  const runs = new Map<string, T>();
  for (const row of rows) {
    observe?.(row);
    const entry = rowToSubagentRunRecord(row);
    if (entry) {
      runs.set(entry.runId, project(entry));
    }
  }
  return runs;
}

/** Hash physical projection rows before decoding, including malformed and colliding identities. */
export function loadSubagentMaintenanceRunsInDatabase(
  database: Pick<OpenClawStateDatabase, "db">,
): { runs: Map<string, SubagentRunMaintenanceRecord>; digest: string } {
  return runSqliteDeferredTransactionSync(database.db, () => {
    const hash = createHash("sha256");
    const runs = decodeSubagentRegistryRows(
      readSubagentRegistryRows(undefined, database, "maintenance"),
      projectSubagentRunForMaintenance,
      (row) => {
        hash.update(JSON.stringify(row));
      },
    );
    return { runs, digest: hash.digest("hex") };
  });
}

export function subagentMaintenanceDurableBasisMatches(
  database: Pick<OpenClawStateDatabase, "db">,
  basis: SubagentMaintenanceDurableBasis,
): boolean {
  return loadSubagentMaintenanceRunsInDatabase(database).digest === basis.digest;
}

/** Native maintenance rechecks only its victims after observing a foreign commit. */
export function loadSubagentMaintenanceCandidatesInDatabase(
  database: Pick<OpenClawStateDatabase, "db">,
  sessionKeys: readonly string[],
): Map<string, SubagentRunMaintenanceRecord> {
  const runs = new Map<string, SubagentRunMaintenanceRecord>();
  for (let offset = 0; offset < sessionKeys.length; offset += 64) {
    const selected = decodeSubagentRegistryRows(
      readSubagentRegistryRows(
        { kind: "children", sessionKeys: sessionKeys.slice(offset, offset + 64) },
        database,
        "maintenance",
      ),
      projectSubagentRunForMaintenance,
    );
    for (const [runId, run] of selected) {
      runs.set(runId, run);
    }
  }
  return runs;
}

/** Loads only the canonical fields needed to build session-list topology metadata. */
export function loadSubagentSessionListRunsFromSqlite(
  controllerSessionKeys: readonly string[] | undefined,
  database: Pick<OpenClawStateDatabase, "db">,
): Map<string, SubagentRunReadRecord> {
  const runs = new Map<string, SubagentRunReadRecord>();
  const keys = controllerSessionKeys?.map((key) => key.trim()).filter(Boolean);
  if (keys?.length === 0) {
    return runs;
  }
  for (const row of readSubagentSessionListRows({ controllerSessionKeys: keys }, database)) {
    const entry = rowToSubagentRunRecord({
      ...row,
      run_id: row.run_id.trim(),
      child_session_key: row.child_session_key.trim(),
      requester_session_key: row.requester_session_key.trim(),
    });
    if (entry) {
      runs.set(entry.runId, projectSubagentRunForSessionList(entry));
    }
  }
  return runs;
}

/** Select identities and physical records in one snapshot, before codec filtering. */
export function loadSubagentRunsForSessionsInDatabase(
  database: Pick<OpenClawStateDatabase, "db">,
  sessionKeys: readonly string[],
  inMemoryRuns: Iterable<Pick<SubagentRunReadRecord, "childSessionKey" | "requesterSessionKey">>,
) {
  const hash = createHash("sha256");
  const { db } = database;
  const result = runSqliteDeferredTransactionSync(db, () => {
    const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
    const identities = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("subagent_runs")
        .select(["run_id", "child_session_key", "requester_session_key"])
        .orderBy("run_id", "asc"),
    ).rows;
    const selected = collectSubagentSessionReadKeys(
      sessionKeys,
      identities.map((row) => ({
        childSessionKey: row.child_session_key,
        requesterSessionKey: row.requester_session_key,
      })),
      inMemoryRuns,
    );
    // Preserve duplicate physical identities, including rows outside the selected tree.
    const selectedRunIds = new Set(
      identities
        .filter((row) => selected.has(row.child_session_key.trim()))
        .map((row) => row.run_id.trim()),
    );
    const runIds = identities
      .filter((row) => selectedRunIds.has(row.run_id.trim()))
      .map((row) => row.run_id);
    const runs = new Map<string, SubagentRunRecord>();
    const complete = runIds.length === identities.length;
    // Topology includes malformed payloads and newly attached descendant branches.
    for (const row of identities) {
      if (selected.has(row.child_session_key.trim()) || selectedRunIds.has(row.run_id.trim())) {
        hash.update(JSON.stringify(["topology", row]));
      }
    }
    if (runIds.length) {
      const query = stateDb.selectFrom("subagent_runs").selectAll();
      const rows = executeSqliteQuerySync(
        db,
        (complete ? query : query.where("run_id", "in", sqliteStringSet(runIds)))
          .orderBy("created_at", "asc")
          .orderBy("run_id", "asc"),
      ).rows;
      for (const row of rows) {
        hash.update(JSON.stringify(["row", row]));
        const entry = rowToSubagentRunRecord(row);
        if (entry) {
          runs.set(entry.runId, entry);
        }
      }
    }
    return { sessionKeys: selected, runIds, runs, complete };
  });
  return { ...result, digest: hash.digest("hex") };
}

export function subagentRunsDurableBasisMatches(
  database: Pick<OpenClawStateDatabase, "db">,
  basis: SubagentRunsDurableBasis,
): boolean {
  return (
    loadSubagentRunsForSessionsInDatabase(database, basis.sessionKeys, basis.liveTopology)
      .digest === basis.digest
  );
}

/** Mutation ownership cannot discard undecodable retained rows as presentation readers do. */
export function hasSubagentSessionOwnerInDatabase(
  database: Pick<OpenClawStateDatabase, "db">,
  sessionKey: string,
): boolean {
  return runSqliteDeferredTransactionSync(database.db, () => {
    const child = executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<SubagentRegistryDatabase>(database.db)
        .selectFrom("subagent_runs")
        .select("run_id")
        .where("child_session_key", "=", sessionKey)
        .limit(1),
    );
    if (child.rows.length > 0) {
      return true;
    }
    return readSubagentRegistryRows({ kind: "session", sessionKey }, database).some((row) => {
      const entry = rowToSubagentRunRecord(row);
      return !entry || !isSettledSubagentRequesterHistory(entry);
    });
  });
}
