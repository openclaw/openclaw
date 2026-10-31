import { expressionBuilder, sql, type ExpressionBuilder, type RawBuilder } from "kysely";
import { jsonRemovePaths, jsonValid } from "../../../infra/database-engine/json-values.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../../infra/kysely-sync.js";
import { isPostgresSqlConnection, type EngineConnection } from "../../../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../../../infra/sqlite-transaction.js";
import { tableExists } from "../../../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import {
  projectSubagentRunForMaintenance,
  projectSubagentRunForSessionList,
} from "./subagent-delivery-state.js";
import type {
  SubagentArchiveReadScope,
  SubagentRunReadRecord,
} from "./subagent-registry-read.types.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import { hasParentStoreColumns } from "./subagent-registry.store.kernel.js";
import type { SubagentRunSqliteRow } from "./subagent-registry.store.row.js";
import type { SubagentRunMaintenanceRecord, SubagentRunRecord } from "./subagent-registry.types.js";
import {
  collectSubagentSessionReadKeys,
  SubagentSessionReadLookup,
} from "./subagent-session-read-scope.js";

type SubagentRegistryDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "subagent_runs" | "subagent_run_archives"
>;
function parentStoreColumns(db: EngineConnection) {
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
  | { kind: "runs"; runIds: readonly string[] };

function subagentControllerFilter(controllerSessionKeys: readonly string[]) {
  // The writer trims controller keys; older null/empty rows belong to their requester.
  return (eb: ExpressionBuilder<SubagentRegistryDatabase, keyof SubagentRegistryDatabase>) =>
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
  table: keyof SubagentRegistryDatabase = "subagent_runs",
): SubagentRunSqliteRow[] {
  const { db } = database;
  const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
  let query = stateDb
    .selectFrom(table)
    .select([
      "run_id",
      "child_session_key",
      "controller_session_key",
      "requester_session_key",
      ...parentStoreColumns(db),
      "created_at",
    ])
    .select(
      projection === "full" ? "payload_json" : subagentMaintenancePayload(db).as("payload_json"),
    );
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
function subagentMetadataPayload(db: EngineConnection): RawBuilder<string | null> {
  if (isPostgresSqlConnection(db)) {
    // JSON text can retain values jsonb cannot represent; maintenance keeps its full-reader fallback.
    return /* kysely-allow-raw: Guard the engine's JSON mutation without changing stored payload bytes. */ sql<
      string | null
    >`CASE WHEN pg_input_is_valid(payload_json, 'jsonb') THEN ${jsonRemovePaths(
      db,
      expressionBuilder<SubagentRegistryDatabase, "subagent_runs">().ref("payload_json"),
      subagentRetainedPayloadPaths.flatMap((path) => [
        sql.val(path),
        sql.val(`$.parentCompletion${path.slice(1)}`),
      ]),
    )} ELSE NULL END`;
  }
  return (
    /* kysely-allow-raw: omit retained bodies without selecting the first duplicate envelope. */
    sql<string | null>`CASE WHEN json_valid(payload_json)
      AND length(CAST(payload_json AS BLOB)) = length(CAST(printf('%s', payload_json) AS BLOB))
    THEN json_remove(payload_json, ${sql.join(subagentRetainedPayloadPaths.flatMap((path) => [path, `$.parentCompletion${path.slice(1)}`]))})
    ELSE NULL END`
  );
}

// Maintenance must send malformed/overdepth text to the original parser.
const subagentMaintenancePayload = (db: EngineConnection) =>
  /* kysely-allow-raw: preserve full-reader parsing when SQLite cannot trim the payload. */
  sql<string>`COALESCE(${subagentMetadataPayload(db)}, payload_json)`;

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
  db: EngineConnection,
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
  if (isPostgresSqlConnection(db)) {
    const valueType = sql`json_typeof(${value})`;
    const ordinal =
      /* kysely-allow-raw: depth aliases belong to this static metadata projection. */ sql.ref(
        `${alias}.ordinality`,
      );
    const nested = [...members].flatMap(([name, children]) =>
      children.length
        ? [
            sql`WHEN ${key} = ${name} AND ${valueType} = 'object' THEN ${projectSessionListJsonMembers(db, value, children, depth + 1)}::json`,
          ]
        : [],
    );
    // Keep duplicate envelopes ordered for the canonical parser's last-key selection.
    return /* kysely-allow-raw: PostgreSQL's JSON member projection preserves the bounded metadata contract. */ sql<string>`(SELECT coalesce(json_object_agg(${key}, CASE
      ${sql.join(nested, sql` `)}
      WHEN ${valueType} = 'object' THEN '{}'::json WHEN ${valueType} = 'array' THEN '[]'::json
      ELSE ${value} END ORDER BY ${ordinal})::text, '{}')
      FROM json_each(${payload}::json) WITH ORDINALITY AS ${cursor}
      WHERE ${key} IN (${sql.join([...members.keys()])}))`;
  }
  const nested = [...members].flatMap(([name, children]) =>
    children.length
      ? [
          sql`WHEN ${key} = ${name} AND ${type} = 'object' THEN json(${projectSessionListJsonMembers(db, value, children, depth + 1)})`,
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

const subagentSessionListPayload = (db: EngineConnection) =>
  projectSessionListJsonMembers(
    db,
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
  scope: {
    controllerSessionKeys?: readonly string[];
    childSessionKeys?: readonly string[];
    runIds?: readonly string[];
  },
  database: Pick<OpenClawStateDatabase, "db">,
  table: keyof SubagentRegistryDatabase = "subagent_runs",
) {
  const { db } = database;
  const postgres = isPostgresSqlConnection(db);
  const payload = expressionBuilder<SubagentRegistryDatabase, "subagent_runs">().ref(
    "payload_json",
  );
  const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
  return executeSqliteQuerySync(
    db,
    stateDb
      .with(
        (cte) => cte("metadata_runs").materialized(),
        (query) => {
          const selected = query
            .selectFrom(table)
            .select([
              "run_id",
              "child_session_key",
              "controller_session_key",
              "requester_session_key",
              ...parentStoreColumns(db),
              "created_at",
              (postgres
                ? /* kysely-allow-raw: The recursive PostgreSQL projection omits retained bodies without a jsonb conversion. */ sql<
                    string | null
                  >`CASE WHEN ${jsonValid(db, payload)} THEN ${payload} ELSE NULL END`
                : subagentMetadataPayload(db)
              ).as("payload_json"),
            ]);
          return scope.controllerSessionKeys
            ? selected.where(subagentControllerFilter(scope.controllerSessionKeys))
            : scope.childSessionKeys
              ? selected.where("child_session_key", "in", sqliteStringSet(scope.childSessionKeys))
              : scope.runIds
                ? selected.where("run_id", "in", sqliteStringSet(scope.runIds))
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
        (postgres
          ? /* kysely-allow-raw: Escaped NUL is valid JSON text but cannot pass PostgreSQL's JSON iterators; the worker codec still projects those rows. */ sql<string>`CASE WHEN pg_input_is_valid(${payload}, 'jsonb') THEN ${subagentSessionListPayload(db)} ELSE ${payload} END`
          : subagentSessionListPayload(db)
        ).as("payload_json"),
      ])
      .where(
        postgres
          ? /* kysely-allow-raw: malformed payloads cannot enter JSON member projection. */ sql<boolean>`json_typeof(${payload}::json) = 'object'`
          : /* kysely-allow-raw: malformed payloads cannot enter JSON member projection. */ sql<boolean>`json_valid(payload_json) AND json_type(payload_json) = 'object'`,
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

export function loadSubagentRunsByIdsInDatabase(
  database: Pick<OpenClawStateDatabase, "db">,
  runIds: readonly string[],
): Map<string, SubagentRunRecord> {
  return decodeSubagentRegistryRows(
    runIds.length === 0 ? [] : readSubagentRegistryRows({ kind: "runs", runIds }, database),
    (entry) => entry,
  );
}

function decodeSubagentRegistryRows<T>(
  rows: Iterable<SubagentRunSqliteRow>,
  project: (entry: SubagentRunRecord) => T,
): Map<string, T> {
  const runs = new Map<string, T>();
  for (const row of rows) {
    const entry = rowToSubagentRunRecord(row);
    if (entry) {
      runs.set(entry.runId, project(entry));
    }
  }
  return runs;
}

/** Read the bounded projection needed by maintenance protection. */
export function loadSubagentMaintenanceRunsInDatabase(
  database: Pick<OpenClawStateDatabase, "db">,
): Map<string, SubagentRunMaintenanceRecord> {
  return decodeSubagentRegistryRows(
    readSubagentRegistryRows(undefined, database, "maintenance"),
    projectSubagentRunForMaintenance,
  );
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
    row.run_id = row.run_id.trim();
    row.child_session_key = row.child_session_key.trim();
    row.requester_session_key = row.requester_session_key.trim();
    const entry = rowToSubagentRunRecord(row);
    if (entry) {
      runs.set(entry.runId, projectSubagentRunForSessionList(entry));
    }
  }
  return runs;
}

/** Traverse indexed relationships before reading any historical payload or unrelated identity. */
function selectSubagentArchiveSessionRunIds(
  database: Pick<OpenClawStateDatabase, "db">,
  scope: Extract<SubagentArchiveReadScope, { kind: "sessions" }>,
): string[] {
  const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(database.db);
  if (
    !executeSqliteQuerySync(
      database.db,
      stateDb
        .selectFrom("subagent_run_archives")
        .select((eb) => eb.val(1).as("present"))
        .limit(1),
    ).rows.length
  ) {
    return [];
  }
  const owners = new Set(scope.sessionKeys.map((key) => key.trim()).filter(Boolean));
  const children = new Set(scope.descendants ? owners : []);
  const selected = new Set<string>();
  const liveChildren = new Map<string, Set<string>>();
  for (const entry of scope.liveTopology ?? []) {
    const owner = entry.requesterSessionKey.trim();
    const owned = liveChildren.get(owner) ?? new Set<string>();
    owned.add(entry.childSessionKey.trim());
    liveChildren.set(owner, owned);
  }
  let frontier = [...owners];
  while (frontier.length) {
    const next: string[] = [];
    const visitChild = (child: string) => {
      if (!child) {
        return;
      }
      children.add(child);
      if (scope.descendants && !owners.has(child)) {
        owners.add(child);
        next.push(child);
      }
    };
    for (const table of ["subagent_runs", "subagent_run_archives"] as const) {
      const rows = executeSqliteQuerySync(
        database.db,
        stateDb
          .selectFrom(table)
          .select(["run_id", "child_session_key"])
          .where((eb) =>
            eb.or([
              eb("requester_session_key", "in", sqliteStringSet(frontier)),
              eb("controller_session_key", "in", sqliteStringSet(frontier)),
            ]),
          ),
      ).rows;
      for (const row of rows) {
        if (table === "subagent_run_archives") {
          selected.add(row.run_id);
        }
        visitChild(row.child_session_key);
      }
    }
    for (const owner of frontier) {
      for (const child of liveChildren.get(owner) ?? []) {
        visitChild(child);
      }
    }
    frontier = next;
  }
  if (children.size) {
    // Include moved/newer generations; the reader's latest-child veto owns selection policy.
    for (const row of executeSqliteQuerySync(
      database.db,
      stateDb
        .selectFrom("subagent_run_archives")
        .select("run_id")
        .where("child_session_key", "in", sqliteStringSet([...children])),
    ).rows) {
      selected.add(row.run_id);
    }
  }
  return [...selected];
}

/** Archive reads are request-owned; neither startup hydration nor resident caches call this. */
export function loadSubagentArchivedRunsInDatabase(
  database: Pick<OpenClawStateDatabase, "db">,
  scope: SubagentArchiveReadScope,
  projection: "full" | "sessionList",
): Map<string, SubagentRunRecord> {
  const { db } = database;
  // Fixed reads admit supported historical backups without migrating their schema.
  if (!tableExists(db, "subagent_run_archives")) {
    return new Map();
  }
  if (
    (scope.kind === "ids" && scope.runIds.length === 0) ||
    ((scope.kind === "children" || scope.kind === "sessions") && scope.sessionKeys.length === 0)
  ) {
    return new Map();
  }
  return runSqliteReadSnapshotSync(db, () => {
    let selectedIds: readonly string[] | undefined;
    if (scope.kind === "sessions") {
      selectedIds = selectSubagentArchiveSessionRunIds(database, scope);
    } else if (scope.kind === "ids" && scope.exact) {
      selectedIds = scope.runIds;
    }
    if (selectedIds) {
      if (!selectedIds.length) {
        return new Map();
      }
      return decodeSubagentRegistryRows(
        projection === "full"
          ? readSubagentRegistryRows(
              { kind: "runs", runIds: selectedIds },
              database,
              "full",
              "subagent_run_archives",
            )
          : readSubagentSessionListRows({ runIds: selectedIds }, database, "subagent_run_archives"),
        (entry) => entry,
      );
    }
    const archived = decodeSubagentRegistryRows(
      readSubagentSessionListRows(
        scope.kind === "children" ? { childSessionKeys: scope.sessionKeys } : {},
        database,
        "subagent_run_archives",
      ),
      (entry) => entry,
    );
    const lookup = new SubagentSessionReadLookup(archived);
    let runIds: readonly string[];
    if (scope.kind === "ids") {
      runIds = lookup.selectRunIds(new Set(scope.runIds));
    } else {
      runIds = [...archived.keys()];
    }
    if (projection === "sessionList" || runIds.length === 0) {
      return new Map(
        runIds.flatMap((runId) => {
          const entry = archived.get(runId);
          return entry ? [[runId, entry]] : [];
        }),
      );
    }
    return decodeSubagentRegistryRows(
      readSubagentRegistryRows({ kind: "runs", runIds }, database, "full", "subagent_run_archives"),
      (entry) => entry,
    );
  });
}

/** Select identities and physical records in one snapshot, before codec filtering. */
export function loadSubagentRunsForSessionsInDatabase(
  database: Pick<OpenClawStateDatabase, "db">,
  sessionKeys: readonly string[],
  inMemoryRuns: Iterable<Pick<SubagentRunReadRecord, "childSessionKey" | "requesterSessionKey">>,
) {
  const { db } = database;
  const result = runSqliteReadSnapshotSync(db, () => {
    const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
    const identities = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("subagent_runs")
        .select(["run_id", "child_session_key", "requester_session_key"])
        .orderBy("run_id", "asc"),
    ).rows;
    const tables: Array<keyof SubagentRegistryDatabase> = ["subagent_runs"];
    if (tableExists(db, "subagent_run_archives")) {
      tables.unshift("subagent_run_archives");
      identities.push(
        ...executeSqliteQuerySync(
          db,
          stateDb
            .selectFrom("subagent_run_archives")
            .select(["run_id", "child_session_key", "requester_session_key"])
            .orderBy("run_id", "asc"),
        ).rows,
      );
    }
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
    if (runIds.length) {
      for (const table of tables) {
        const query = stateDb.selectFrom(table).selectAll();
        const rows = executeSqliteQuerySync(
          db,
          (complete ? query : query.where("run_id", "in", sqliteStringSet(runIds)))
            .orderBy("created_at", "asc")
            .orderBy("run_id", "asc"),
        ).rows;
        for (const row of rows) {
          const entry = rowToSubagentRunRecord(row);
          if (entry) {
            runs.set(entry.runId, entry);
          }
        }
      }
    }
    return { sessionKeys: selected, runIds, runs, complete };
  });
  return result;
}
