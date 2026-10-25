import type { DatabaseSync } from "node:sqlite";
import {
  buildMemoryIndexStrictSchema,
  buildMemoryStorageSchema,
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INLINE_RECALL_COLUMNS,
} from "../../packages/memory-host-sdk/src/host/memory-schema-base.js";
import { DAEMON_RUNTIME_PIN_SCHEMA_SQL } from "../../src/daemon/runtime-pin-schema.js";
import { CLIENT_CREDENTIAL_SCHEMA_SQL } from "../../src/infra/client-credential-schema.js";
import {
  buildSqliteMemoryBodyFtsSchema,
  buildSqliteMemoryPathFtsSchema,
  buildSqliteMemoryVectorSchema,
} from "../../src/infra/database-engine/sqlite-memory-search-fragments.js";
import { loadSqliteVecExtension } from "../../src/infra/database-engine/sqlite-vec.js";
import { extractSqliteTableSchema } from "../../src/infra/sqlite-schema-sql.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../src/state/openclaw-agent-db-contract.js";
import {
  AGENT_PROGRESS_CARD_SCHEMA_SQL,
  AGENT_V14_ADDITIVE_SCHEMA_SQL,
  AGENT_V14_BOARD_SCHEMA_SQL,
  AGENT_V14_CORE_SCHEMA_SQL,
  AGENT_V14_SESSION_SHARING_SCHEMA_SQL,
  getOpenClawAgentMigrationSchema,
  LEGACY_PARTICIPANTS_SCHEMA,
  RETIRED_AGENT_STATE_LEASE_SCHEMA_SQL,
} from "../../src/state/openclaw-agent-schema-history.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../src/state/openclaw-agent-schema.js";
import { withLegacyAgentStorageSchema } from "../../src/state/openclaw-agent-storage-schema.js";
import { DEPLOYED_FTS_ROWS_SCHEMA } from "../../src/state/openclaw-agent-transcript-fts-schema-source.js";
import { withLegacyStateHeadLayout } from "../../src/state/openclaw-state-db-schema-v26-layout.js";
import { withLegacyStateWriteIndexes } from "../../src/state/openclaw-state-db-schema-v27-indexes.js";
import { withLegacyLocalWorkspaceManifests } from "../../src/state/openclaw-state-db-schema-v31-workspace-manifests.js";
import {
  getOpenClawStateFeatureSchemaSql,
  listOpenClawStateFeatureSchemas,
} from "../../src/state/openclaw-state-feature-schema.js";
import {
  RETIRED_COMMITMENTS_SCHEMA_SQL,
  SHIPPED_RETIRED_COMMITMENTS_SCHEMA_SQL,
} from "../../src/state/openclaw-state-schema-retired.js";
import { getOpenClawStateRuntimeSchema } from "../../src/state/openclaw-state-schema-runtime.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../src/state/openclaw-state-schema.js";

export type SqliteSchemaInput = {
  id: string;
  store: string;
  sql: string;
  /** Build-only setup for computed fragments that require extensions, such as dimensioned vec0 DDL. */
  prepare?: (database: DatabaseSync) => void | Promise<void>;
};

/** Exact source strings accepted by each owner's expected-schema inspection. */
export function listSqliteSchemaInputs(): SqliteSchemaInput[] {
  const inputs: SqliteSchemaInput[] = [];
  const add = (id: string, store: SqliteSchemaInput["store"], sql: string) => {
    inputs.push({ id, store, sql });
  };
  add("state", "state", OPENCLAW_STATE_SCHEMA_SQL);
  const stateBeforeV31 = withLegacyLocalWorkspaceManifests(OPENCLAW_STATE_SCHEMA_SQL);
  add("state-before-v31", "state", stateBeforeV31);
  const stateBeforeV27 = withLegacyStateWriteIndexes(stateBeforeV31);
  add("state-before-v27", "state", stateBeforeV27);
  add("state-before-v26", "state", withLegacyStateHeadLayout(stateBeforeV27));
  add("agent", "agent", OPENCLAW_AGENT_SCHEMA_SQL);
  add("daemon-runtime-pins-v1", "daemon", DAEMON_RUNTIME_PIN_SCHEMA_SQL);
  add("client-credentials-v1", "client", CLIENT_CREDENTIAL_SCHEMA_SQL);

  for (const includeEmbeddingCache of [false, true]) {
    add(
      `memory-index-v1-cache-${Number(includeEmbeddingCache)}`,
      "memory",
      buildMemoryIndexStrictSchema({
        embeddingCacheTable: MEMORY_EMBEDDING_CACHE_TABLE,
        includeEmbeddingCache,
      }),
    );
  }
  for (const legacy of [false, true]) {
    for (const strict of legacy ? [false, true] : [true]) {
      const version = legacy ? "text" : "binary";
      add(
        `memory-cache-${version}-strict-${Number(strict)}`,
        "memory",
        buildMemoryStorageSchema({
          table: MEMORY_EMBEDDING_CACHE_TABLE,
          chunks: false,
          legacy,
          strict,
        }),
      );
      for (let mask = 0; mask < 1 << MEMORY_INLINE_RECALL_COLUMNS.length; mask++) {
        add(
          `memory-chunks-${version}-strict-${Number(strict)}-recall-${mask}`,
          "memory",
          buildMemoryStorageSchema({
            table: "memory_index_chunks",
            chunks: true,
            legacy,
            strict,
            inlineRecallColumns: MEMORY_INLINE_RECALL_COLUMNS.filter(
              (_, index) => mask & (1 << index),
            ).map(([name]) => name),
          }),
        );
      }
    }
  }

  for (const tokenizer of ["unicode61", "trigram"] as const) {
    add(
      `memory-body-fts-v1-${tokenizer}`,
      "memory",
      buildSqliteMemoryBodyFtsSchema({ tableName: "memory_index_chunks_fts", tokenizer }),
    );
    add(`memory-path-fts-v1-${tokenizer}`, "memory", buildSqliteMemoryPathFtsSchema({ tokenizer }));
  }
  inputs.push({
    id: "memory-vector-v1",
    store: "memory",
    sql: buildSqliteMemoryVectorSchema({ tableName: "memory_index_chunks_vec", dimensions: 1 }),
    prepare: async (db) => {
      const loaded = await loadSqliteVecExtension({ db });
      if (!loaded.ok) {
        throw new Error(loaded.error ?? "Could not load sqlite-vec for schema generation");
      }
    },
  });

  for (const feature of listOpenClawStateFeatureSchemas()) {
    add(`fragment-${feature.id}`, "state", feature.sql());
    for (const table of feature.tables) {
      add(`state-feature-${table}`, "state", getOpenClawStateFeatureSchemaSql(table));
    }
  }

  for (const includeVersionLazyAdditiveTables of [false, true]) {
    for (const includeAgentDeletionJournal of [false, true]) {
      add(
        `state-runtime-${Number(includeVersionLazyAdditiveTables)}-${Number(includeAgentDeletionJournal)}`,
        "state",
        getOpenClawStateRuntimeSchema({
          includeVersionLazyAdditiveTables,
          includeAgentDeletionJournal,
        }),
      );
    }
  }

  // These owner subsets are intentionally narrower than their declared feature fragments.
  for (const table of [
    "agent_database_leases",
    "agent_deletion_journal",
    "config_machine_state",
    "gateway_restart_intent",
    "schema_meta",
    "state_leases",
    "worker_session_tool_operations",
    "worker_turn_tool_authorities",
  ]) {
    add(
      `state-table-${table}`,
      "state",
      extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table),
    );
  }

  const featureEnds = [
    [
      "github_repository_publication_requests",
      "ON github_repository_publication_requests(owner_profile_id, session_id, idempotency_key) WHERE owner_profile_id IS NOT NULL;",
    ],
    [
      "github_publication_requests",
      "ON github_publication_requests(status, updated_at_ms, request_id);",
    ],
    [
      "github_personal_publication_requests",
      "ON github_personal_publication_requests(status, updated_at_ms, request_id);",
    ],
    [
      "secret_store_entries",
      "ON secret_store_entries (scope_kind, scope_id, name) WHERE deleted_at_ms IS NULL;",
    ],
    ["update_runs", "ON update_runs(status, created_at_ms DESC, run_id);"],
  ] as const;
  for (const [table, endMarker] of featureEnds) {
    add(`state-indexed-${table}`, "state", getOpenClawStateFeatureSchemaSql(table, { endMarker }));
  }

  for (const tables of [
    ["schema_meta", "state_leases"],
    ["schema_meta", "state_leases", "agent_database_leases"],
  ]) {
    add(
      `state-existing-${tables.at(-1)}`,
      "state",
      tables
        .map((table) =>
          extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table, { endMarker: ") STRICT;" }),
        )
        .join("\n"),
    );
  }
  const lineageSchema = ["node_worker_launches", "node_worker_launch_cleanup"]
    .map((table) => getOpenClawStateFeatureSchemaSql(table))
    .join("\n");
  add("state-node-worker-lineage", "state", lineageSchema);
  add(
    "state-node-worker-descendants",
    "state",
    lineageSchema + "\n" + getOpenClawStateFeatureSchemaSql("node_worker_launch_process_scopes"),
  );

  add("state-retired-commitments", "state", RETIRED_COMMITMENTS_SCHEMA_SQL);
  add("state-retired-commitments-shipped", "state", SHIPPED_RETIRED_COMMITMENTS_SCHEMA_SQL);

  // Pre-v8 stores are supported without legacy session tables. Equal targets share one input.
  for (let version = 1; version <= OPENCLAW_AGENT_SCHEMA_VERSION; version += 1) {
    add(`agent-version-${version}`, "agent", getOpenClawAgentMigrationSchema(version));
  }
  for (const [id, sql] of [
    ["agent-v14-core", AGENT_V14_CORE_SCHEMA_SQL],
    ["agent-v14-session-sharing", AGENT_V14_SESSION_SHARING_SCHEMA_SQL],
    ["agent-v14-additive", AGENT_V14_ADDITIVE_SCHEMA_SQL],
    ["agent-v14-board", AGENT_V14_BOARD_SCHEMA_SQL],
    ["agent-progress-card", AGENT_PROGRESS_CARD_SCHEMA_SQL],
    ["agent-retired-state-leases", RETIRED_AGENT_STATE_LEASE_SCHEMA_SQL],
    ["agent-legacy-participants", LEGACY_PARTICIPANTS_SCHEMA],
    ["agent-deployed-fts-rows", DEPLOYED_FTS_ROWS_SCHEMA],
    [
      "agent-legacy-transcript-events",
      extractSqliteTableSchema(
        withLegacyAgentStorageSchema(OPENCLAW_AGENT_SCHEMA_SQL),
        "transcript_events",
      ),
    ],
  ] as const) {
    add(id, "agent", sql);
  }

  return inputs;
}
