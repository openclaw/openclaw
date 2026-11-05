#!/usr/bin/env node

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  LOGBOOK_SCHEMA_VERSION,
  SCHEMA as LOGBOOK_SCHEMA_SQL,
} from "../extensions/logbook/src/store-schema.ts";
import {
  TEAM_REPORTS_SCHEMA_SQL,
  TEAM_REPORTS_SCHEMA_VERSION,
} from "../extensions/team-reports/src/store-schema.ts";
import {
  SCHEMA_VERSION,
  WORKBOARD_SCHEMA_SQL,
} from "../extensions/workboard/src/workboard-schema.ts";
import { MEMORY_PATH_POSTGRES_INDEXES } from "../packages/memory-host-sdk/src/host/memory-path-postgres.ts";
import { CLIENT_CREDENTIAL_LEGACY_TABLES_SQL } from "../src/infra/client-credential-schema.ts";
import {
  assertPostgresCatalog,
  expectedPostgresCatalog,
  postgresCatalogQuery,
  readPostgresCatalog,
} from "../src/infra/database-engine/postgres-catalog.ts";
import { withLegacyPostgresIndexOrdering } from "../src/infra/database-engine/postgres-index-ordering.ts";
import { extractSqliteTableSchema } from "../src/infra/sqlite-schema-sql.ts";
import { AGENT_TRANSCRIPT_SEARCH_POSTGRES_SQL } from "../src/state/openclaw-agent-search-schema.ts";
import { DOCTOR_OWNED_STATE_TABLES } from "../src/state/openclaw-state-db-contract.ts";
import {
  TASK_RUN_INDEX_RETIREMENT_V24_SQL,
  TASK_RUN_INDEX_REPLACEMENTS_V24,
} from "../src/state/openclaw-state-db-schema-v24-indexes.ts";
import {
  STATE_WRITE_INDEX_RETIREMENT_V27_SQL,
  withLegacyStateWriteIndexes,
} from "../src/state/openclaw-state-db-schema-v27-indexes.ts";
import {
  WORKSPACE_CAS_COLUMNS,
  WORKSPACE_CAS_TABLES,
} from "../src/state/openclaw-state-db-schema-v35-workspace-cas.ts";
import { listOpenClawStateFeatureSchemas } from "../src/state/openclaw-state-feature-schema.ts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { formatGeneratedModule } from "./lib/format-generated-module.mts";
import { checkAgentPostgresBehavior } from "./lib/postgres-agent-conformance.mts";
import {
  catalog,
  portTables,
  quote,
  sqliteOnlyNulGuards,
  type Catalog,
} from "./lib/postgres-schema-catalog.mts";
import {
  assertPostgresTriggers,
  translatePostgresTriggers,
} from "./lib/postgres-schema-triggers.mts";
import { checkStateTaskIndexMigration } from "./lib/postgres-state-index-conformance.mts";
import { generateSqliteSchemaCatalogs } from "./lib/sqlite-schema-generation.mts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MINIMUM_POSTGRES_VERSION = 16;
const WORKBOARD_OUTPUT = "extensions/workboard/src/workboard-schema.postgres.sql";
const WORKBOARD_PORT_OUTPUT = "src/infra/database-engine/workboard-port.generated.json";
const LOGBOOK_OUTPUT = "extensions/logbook/src/logbook-schema.postgres.sql";
const LOGBOOK_PORT_OUTPUT = "src/infra/database-engine/logbook-port.generated.json";
const OUTPUT = "src/state/postgres-schema.generated";
export const pendingPromotion: readonly { name: string; reason: string }[] = Object.freeze([]);
const sqliteOnlyAllowList = sqliteOnlyNulGuards.map((column) => ({
  column,
  reason: "PostgreSQL text cannot hold NUL; the guard is enforced by the type.",
}));

function tableStatements(data: Catalog): string[] {
  return ["function", "table", "index", "foreignKey", "triggerFunction", "trigger"].flatMap(
    (kind) =>
      data.objects
        .filter(
          (item) =>
            item.kind === kind && item.sql && (kind !== "index" || item.sql.startsWith("CREATE")),
        )
        .map((item) => item.sql!),
  );
}

function postgresPortDataRanges(data: Catalog, postgres: string) {
  const postData = tableStatements(data).find((sql) =>
    data.objects.some(
      (object) =>
        ["index", "foreignKey", "triggerFunction", "trigger"].includes(object.kind) &&
        object.sql === sql,
    ),
  );
  const split = postData ? postgres.indexOf(postData) : postgres.length;
  assert.ok(split >= 0, "Generated PostgreSQL port DDL differs from its catalog");
  return { preData: [0, split], postData: [split, postgres.length] };
}

async function generateClientCredentialSource() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(CLIENT_CREDENTIAL_LEGACY_TABLES_SQL);
    const data = catalog(db, "");
    for (const item of data.objects) {
      if (item.kind === "index" && item.sql) {
        item.sql = withLegacyPostgresIndexOrdering(item.sql);
      }
    }
    const sql = tableStatements(data).join("\n\n");
    return {
      sql,
      ...postgresPortDataRanges(data, sql),
      tables: portTables(data).map(({ name, identities }) => ({ name, identities })),
      expectedCatalog: expectedPostgresCatalog(data),
    };
  } finally {
    db.close();
  }
}

/** Shared metadata recipe; family owners supply canonical SQLite and generated PostgreSQL DDL. */
function generateDatabasePortMetadata(
  db: import("node:sqlite").DatabaseSync,
  data: Catalog,
  source: { id: string; version: number; sqlite: string; postgres: string },
) {
  return {
    id: source.id,
    version: source.version,
    minimumPostgresVersion: MINIMUM_POSTGRES_VERSION,
    schema: "",
    sqlite: source.sqlite,
    tables: portTables(data),
    objects: data.objects
      .filter((item) => item.kind === "check")
      .map(({ table, kind, sql }) => ({ table, kind, sql })),
    triggers: db
      .prepare(
        "SELECT name, tbl_name AS 'table', sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
      )
      .all()
      .filter((trigger) => data.tables.some((table) => table.name === trigger.table)),
    ...postgresPortDataRanges(data, source.postgres),
  };
}

async function generatePluginPostgresSchema(source: {
  id: string;
  label: string;
  version: number;
  sqlite: string;
  allowSqliteSequence?: boolean;
}) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(source.sqlite);
    // Empty schema leaves qualification to the connection owner's search_path.
    const data = catalog(db, "");
    // SQLite owns AUTOINCREMENT ledgers; port allocation metadata preserves them.
    const omissions = data.objects.filter(
      (item) =>
        item.sql === null && !(source.allowSqliteSequence && item.table === "sqlite_sequence"),
    );
    if (omissions.length) {
      throw new Error(
        `${source.label} PostgreSQL schema has unsupported objects: ${omissions.map((item) => `${item.kind} ${item.table}.${item.name}: ${item.reason}`).join("; ")}`,
      );
    }
    const statements = tableStatements(data);
    const postgresSql = `${[
      `-- Generated by pnpm db:postgres:gen --target ${source.id}. Do not edit.`,
      "-- The connection owner supplies search_path and the admission transaction.",
      ...statements,
    ].join("\n\n")}\n`;
    const portMetadata = generateDatabasePortMetadata(db, data, {
      ...source,
      postgres: postgresSql,
    });
    return {
      catalog: data,
      sql: postgresSql,
      portMetadata,
    };
  } finally {
    db.close();
  }
}

export function generateWorkboardPostgresSchema() {
  return generatePluginPostgresSchema({
    id: "workboard",
    label: "Workboard",
    version: SCHEMA_VERSION,
    sqlite: WORKBOARD_SCHEMA_SQL,
  });
}

export function generateLogbookPostgresSchema() {
  return generatePluginPostgresSchema({
    id: "logbook",
    label: "Logbook",
    version: LOGBOOK_SCHEMA_VERSION,
    sqlite: LOGBOOK_SCHEMA_SQL,
    allowSqliteSequence: true,
  });
}

export async function generatePostgresSchemas(
  root = ROOT,
  prefix = "openclaw",
  options: { reportOnly?: boolean; includeJsonReport?: boolean } = {},
) {
  if (!prefix || Buffer.byteLength(`${prefix}_state`) > 63 || prefix.includes("\0")) {
    throw new Error("Schema prefix must fit PostgreSQL's 63-byte identifier limit");
  }
  const { DatabaseSync } = await import("node:sqlite");
  const catalogs: Record<string, Catalog> = {};
  const files: Record<string, string> = {};
  const fragments =
    root === ROOT
      ? [
          ...listOpenClawStateFeatureSchemas(),
          // Absence means lost history: retain it on port without recreating it on admission.
          ...DOCTOR_OWNED_STATE_TABLES.map((id) => ({
            id,
            tables: [id],
            indexes: [],
            dependencies: [],
            activation: "version-additive" as const,
            sql: () =>
              extractSqliteTableSchema(
                fs.readFileSync(path.join(root, "src/state/openclaw-state-schema.sql"), "utf8"),
                id,
              ),
          })),
        ]
      : [];
  const manifest = fragments.map(({ id, tables, indexes, dependencies, activation }) => ({
    id,
    tables,
    indexes,
    dependencies,
    activation,
    file: `fragment-${id}.postgres.sql`,
  }));
  for (const name of ["state", "agent"]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(fs.readFileSync(path.join(root, `src/state/openclaw-${name}-schema.sql`), "utf8"));
      if (name === "state") {
        for (const fragment of fragments) {
          db.exec(fragment.sql());
        }
      }
      const namespace = `${prefix}_${name}`;
      // Runtime DDL uses the owner's search_path; catalog checks target its chosen namespace.
      catalogs[name] = { ...catalog(db, ""), schema: namespace };
    } finally {
      db.close();
    }
    const data = catalogs[name]!;
    if (name === "agent") {
      translatePostgresTriggers(data);
      const sources = data.tables.find((table) => table.name === "memory_index_sources");
      if (sources) {
        sources.indexes += MEMORY_PATH_POSTGRES_INDEXES.length;
        for (const index of MEMORY_PATH_POSTGRES_INDEXES) {
          data.objects.push({
            kind: "index",
            table: sources.name,
            name: index.name,
            source: "PostgreSQL-only derived exact-path identity",
            sql: index.sql,
          });
        }
      }
      data.notes.push(
        "Voice indexes: the sole writer (src/talk/client-voice-session-store.ts) uses JSON.stringify; agentId/sessionKey are strings, origin is client/relay, status is open/closed. src/talk/client-voice-session-lookup.worker.ts compares strings only. Non-string members cannot match; no boolean/numeric coercion is needed. Duplicate-key JSON is unreachable from writers: SQLite resolves first-wins, PostgreSQL last-wins. P3-6 preflight must refuse duplicate-key voice rows before copying, with row evidence. Canonical JSON remains text.",
      );
    }
    if (!options.reportOnly) {
      for (const item of data.objects.filter((entry) => entry.sql === null)) {
        const pending =
          item.kind === "index" && pendingPromotion.find((entry) => entry.name === item.name);
        if (pending) {
          item.reason = pending.reason;
          item.category = "pendingPromotion";
        } else if (
          item.table !== "sqlite_sequence" &&
          !item.pendingCapability &&
          [
            "table",
            "column",
            "default",
            "check",
            "index",
            "foreignKey",
            "trigger",
            "view",
          ].includes(item.kind)
        ) {
          throw new Error(
            `Unsupported ${name === "state" ? "shared-state" : "agent"} ${item.kind} ${item.table}.${item.name}: ${item.source}: ${item.reason}`,
          );
        }
      }
    }
    if (name === "state") {
      const preWriteIndexesV27Sql: Record<string, string> = {};
      let writeIndexesV27Sql = "";
      if (root === ROOT) {
        using historical = new DatabaseSync(":memory:");
        historical.exec(
          withLegacyStateWriteIndexes(
            fs.readFileSync(path.join(root, "src/state/openclaw-state-schema.sql"), "utf8"),
          ),
        );
        for (const item of catalog(historical, "").objects) {
          if (
            item.kind === "index" &&
            item.sql &&
            [
              "idx_acp_replay_events_session_seq",
              "idx_skill_usage_key",
              "idx_state_leases_owner",
            ].includes(item.name)
          ) {
            preWriteIndexesV27Sql[item.table] = withLegacyPostgresIndexOrdering(item.sql);
          }
        }
        assert.equal(Object.keys(preWriteIndexesV27Sql).length, 3);
        const leaseIndex = data.objects.find(
          (item) => item.kind === "index" && item.name === "idx_state_leases_owner",
        );
        assert.ok(leaseIndex?.sql);
        writeIndexesV27Sql = `${STATE_WRITE_INDEX_RETIREMENT_V27_SQL}\n${withLegacyPostgresIndexOrdering(leaseIndex.sql)}`;
      }
      if (root === ROOT) {
        for (const pending of pendingPromotion) {
          assert.ok(
            data.objects.some(
              (item) =>
                item.kind === "index" &&
                item.name === pending.name &&
                item.category === "pendingPromotion",
            ),
            `Stale pendingPromotion entry: ${pending.name}`,
          );
        }
      }
      const ownership = new Map(
        fragments.flatMap((fragment) =>
          fragment.tables.map((table) => [table, fragment.id] as const),
        ),
      );
      const runtimeDdl = (objects: Catalog["objects"]) =>
        `${["-- Generated runtime DDL; the owner supplies search_path and the transaction.", ...tableStatements({ ...data, objects })].join("\n\n")}\n`;
      files["state.postgres.sql"] = runtimeDdl(
        data.objects.filter((item) => !ownership.has(item.table)),
      );
      for (const fragment of manifest) {
        files[fragment.file] = runtimeDdl(
          data.objects.filter((item) => ownership.get(item.table) === fragment.id),
        );
      }
      if (root === ROOT) {
        const replacements = TASK_RUN_INDEX_REPLACEMENTS_V24.map((indexName) => {
          const index = data.objects.find(
            (item) =>
              item.kind === "index" && item.table === "task_runs" && item.name === indexName,
          );
          assert.ok(
            index?.sql && index.sql.startsWith("CREATE INDEX "),
            `Missing translated shared-state v24 index: ${indexName}`,
          );
          return withLegacyPostgresIndexOrdering(index.sql);
        });
        files["state-v23-v24.postgres.sql"] = `${[
          "-- Generated v23-to-v24 forward DDL; the owner supplies search_path, transaction, and version publication.",
          TASK_RUN_INDEX_RETIREMENT_V24_SQL.trim(),
          ...replacements,
        ].join("\n\n")}\n`;
        files["state-v24-v25.postgres.sql"] =
          "-- Generated v24-to-v25 metadata-only transition; the engine owner publishes openclaw_schema_meta.\n" +
          "-- Subagent operator recovery requires the new reader; catalog and retained rows are unchanged.\n" +
          "UPDATE schema_meta SET schema_version = 25 WHERE meta_key = 'primary' AND schema_version = 24;\n" +
          "UPDATE config_machine_state SET value_json = '25' WHERE state_key = 'state.schema.contentVersion' AND value_json = '24';\n";
      }
      if (root === ROOT) {
        files["state-v28-v29.postgres.sql"] =
          "-- Generated v28-to-v29 publication after the local credential owner has verified and retired source rows.\n" +
          "UPDATE schema_meta SET schema_version = 29 WHERE meta_key = 'primary' AND schema_version = 28;\n";
        const additions = WORKSPACE_CAS_COLUMNS.map((column) => {
          const definition = data.objects.find(
            (item) =>
              item.kind === "column" &&
              item.table === "local_workspace_projections" &&
              item.name === column,
          );
          assert.ok(definition?.sql, `Missing workspace CAS column: ${column}`);
          return `ALTER TABLE "local_workspace_projections" ADD COLUMN ${definition.sql};`;
        });
        files["state-v34-v35.postgres.sql"] = [
          "-- Generated DDL-only v34-to-v35 transition; reconciliation converts retained rows online.",
          "DO $workspace_cas$ BEGIN",
          "IF to_regclass('local_workspace_projections') IS NOT NULL THEN",
          ...additions,
          ...tableStatements({
            ...data,
            objects: data.objects.filter((item) =>
              WORKSPACE_CAS_TABLES.some((table) => table === item.table),
            ),
          }),
          "END IF; END $workspace_cas$;\n",
        ].join("\n");
      }
      if (!options.reportOnly) {
        files["runtime.ts"] = formatGeneratedModule(
          `// Generated by pnpm db:postgres:gen. Do not edit.\nexport const statePostgresRuntime = ${JSON.stringify(
            {
              eagerSql: files["state.postgres.sql"],
              operatorRecoveryV25Sql: files["state-v24-v25.postgres.sql"],
              preWriteIndexesV27Sql,
              writeIndexesV27Sql,
              clientCredentialV29Sql: files["state-v28-v29.postgres.sql"],
              workspaceCasV35Sql: files["state-v34-v35.postgres.sql"],
              clientCredentialSource: await generateClientCredentialSource(),
              fragments: manifest.map(({ file, ...fragment }) => ({
                ...fragment,
                sql: files[file],
              })),
              expectedCatalog: expectedPostgresCatalog(data),
            },
            null,
            2,
          )};\n`,
          { repoRoot: ROOT, outputPath: "runtime.ts", errorLabel: "state runtime" },
        );
      }
      if (root === ROOT && !options.reportOnly) {
        files["state-port.json"] =
          `${JSON.stringify(generateStatePortMetadata(root, data, fragments, files), null, 2)}\n`;
      }
      continue;
    }
    files[`${name}.postgres.sql`] =
      `${["-- Generated runtime DDL; the owner supplies search_path and the transaction.", ...tableStatements(data)].join("\n\n")}\n`;
    if (name === "agent" && !options.reportOnly) {
      files["agent-runtime.ts"] = formatGeneratedModule(
        `// Generated by pnpm db:postgres:gen. Do not edit.\nexport const agentPostgresRuntime = ${JSON.stringify({ sql: files["agent.postgres.sql"], expectedCatalog: expectedPostgresCatalog(data) }, null, 2)};\n`,
        { repoRoot: ROOT, outputPath: "agent-runtime.ts", errorLabel: "agent runtime" },
      );
      files["agent-port.json"] =
        `${JSON.stringify(generateAgentPortMetadata(root, data, files["agent.postgres.sql"]!), null, 2)}\n`;
    }
  }
  if (root === ROOT && !options.reportOnly) {
    files["agent-search.postgres.sql"] =
      `-- Generated by pnpm db:postgres:gen. PostgreSQL-only derived transcript content.\n\n${AGENT_TRANSCRIPT_SEARCH_POSTGRES_SQL}`;
    files["agent-search-runtime.ts"] = formatGeneratedModule(
      `// Generated by pnpm db:postgres:gen. Do not edit.\nexport const agentSearchPostgresRuntime = ${JSON.stringify({ sql: files["agent-search.postgres.sql"] }, null, 2)};\n`,
      { repoRoot: ROOT, outputPath: "agent-search-runtime.ts", errorLabel: "agent search runtime" },
    );
  }
  if (!options.reportOnly) {
    const inputs =
      root === ROOT
        ? (await import("./lib/sqlite-schema-inputs.mts")).listSqliteSchemaInputs()
        : (["state", "agent"] as const).map((store) => ({
            id: store,
            store,
            sql: fs.readFileSync(path.join(root, `src/state/openclaw-${store}-schema.sql`), "utf8"),
          }));
    Object.assign(files, await generateSqliteSchemaCatalogs(inputs, ROOT));
  }
  const pendingCapabilities = Object.entries(catalogs).flatMap(([database, data]) =>
    data.objects
      .filter((item) => item.pendingCapability)
      .map(({ kind, table, name, pendingCapability }) => ({
        database,
        kind,
        table,
        name,
        pendingCapability,
      })),
  );
  files["manifest.json"] =
    `${JSON.stringify({ minimumPostgresVersion: MINIMUM_POSTGRES_VERSION, fragments: manifest, pendingPromotion, sqliteOnlyAllowList, pendingCapabilities }, null, 2)}\n`;
  const summary: Record<
    string,
    Record<string, { total: number; translated: number; reported: number }>
  > = {};
  const kinds = [
    "table",
    "column",
    "index",
    "foreignKey",
    "check",
    "trigger",
    "virtualTable",
    "internalTable",
  ];
  for (const [name, data] of Object.entries(catalogs)) {
    const counts: (typeof summary)[string] = {};
    for (const kind of kinds) {
      const items = data.objects.filter((item) => item.kind === kind);
      const translated = items.filter((item) => item.sql !== null).length;
      counts[kind] = { total: items.length, translated, reported: items.length - translated };
    }
    summary[name] = counts;
  }
  const limitations = [
    "Readiness tooling only: SQLite remains the runtime store and canonical .sql files remain authoritative. No data migration or runtime SQL/concurrency conformance is proved.",
    "Agent runtime DDL represents one admitted store UUID per owner-supplied namespace. Agent PostgreSQL enablement remains blocked on the pending search capability and runtime cutover.",
    "Text uses C collation. PostgreSQL text rejects NUL; SQLite length(text) stops at NUL. Data validation and numeric/JSON representation differences need a separate migration contract.",
    "STRICT and WITHOUT ROWID options are removed. Identity sequences do not reproduce SQLite rowid/AUTOINCREMENT/sqlite_sequence allocation or rollback semantics; each rowid alias adds a PostgreSQL PK index absent from SQLite's index_list.",
    "Not covered: runtime-created memory FTS5 in src/infra/database-engine/sqlite-search-schema.ts; vec0 in src/infra/database-engine/sqlite-vector.ts.",
    "Not covered: plugin-owned databases, including extensions/workboard/src/sqlite-store-schema.ts, extensions/logbook/src/store-schema.ts and extensions/team-reports/src/store-schema.ts.",
    "Not covered: additive/startup repair DDL in src/state/*-schema.ts and *migration*.ts, including openclaw-agent-transcript-fts-schema.ts, openclaw-agent-board-schema.ts and openclaw-agent-canonical-validation-migration.ts.",
    "Agent runtime update: the preceding agent search/cutover limitation is superseded. The generated PostgreSQL-only transcript projection and engine search admission enable agent transcript text search. PostgreSQL memory search still awaits its owner cutover.",
  ];
  const report = {
    summary,
    limitations,
    pendingPromotion,
    sqliteOnlyAllowList,
    pendingCapabilities,
    fragments: manifest,
    catalogs,
  };
  if (options.includeJsonReport) {
    files["portability-report.json"] = `${JSON.stringify(report, null, 2)}\n`;
  }
  const markdown = [
    "# PostgreSQL portability report",
    "",
    ...limitations.map((line) => `- ${line}`),
    "",
    "## Counts",
    "",
    "Database | Object | Total | Translated | Reported",
    "--- | --- | ---: | ---: | ---:",
  ];
  for (const [name, counts] of Object.entries(summary)) {
    for (const [kind, count] of Object.entries(counts)) {
      markdown.push(`${name} | ${kind} | ${count.total} | ${count.translated} | ${count.reported}`);
    }
  }
  for (const [name, data] of Object.entries(catalogs)) {
    markdown.push(
      "",
      `## ${name}: omissions and semantic notes`,
      "",
      ...data.notes.map((note) => `- ${note}`),
    );
    for (const item of data.objects.filter((entry) => entry.sql === null)) {
      markdown.push(
        `- ${item.kind} \`${item.table}.${item.name}\`: ${item.reason}${item.pendingCapability ? `; pendingCapability: ${item.pendingCapability}` : ""}${item.category ? `; ${item.category}${item.design ? `; ${item.design}` : ""}` : ""}. Source: \`${item.source.replaceAll("`", "\\`").replaceAll("\n", " ")}\``,
      );
    }
  }
  files["portability-report.md"] = formatGeneratedModule(`${markdown.join("\n")}\n`, {
    repoRoot: ROOT,
    outputPath: "portability-report.md",
    errorLabel: "PostgreSQL portability report",
  });
  return { files, report };
}

async function verifyPostgres(
  catalogs: Record<string, Catalog>,
  querySql: (sql: string) => Promise<unknown>,
): Promise<void> {
  for (const data of Object.values(catalogs)) {
    const actual = readPostgresCatalog(await querySql(postgresCatalogQuery(data.schema)));
    assertPostgresCatalog(actual, expectedPostgresCatalog(data));
    if (data.schema.endsWith("_agent")) {
      await assertPostgresTriggers(data, querySql);
    }
    console.log(
      `${data.schema}: verified ${data.tables.length} tables, ${data.tables.reduce((sum, table) => sum + table.columns.length, 0)} columns, ${data.objects.filter((item) => item.kind === "check").length} CHECKs, ${data.tables.reduce((sum, table) => sum + table.indexes, 0)} indexes, ${data.tables.reduce((sum, table) => sum + table.foreignKeys.length, 0)} FKs; zero unexplained differences (types/nullability/defaults/identity, PK, UNIQUE, FK actions/deferrability)`,
    );
  }
}

async function checkPostgresCatalog(connection: string): Promise<void> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: connection });
  const prefix = `conformance_${process.pid}`;
  await client.connect();
  try {
    if (
      Number((await client.query("SHOW server_version_num")).rows[0].server_version_num) < 160000
    ) {
      throw new Error("Shared-state schema requires PostgreSQL 16 or newer (IS JSON)");
    }
    const generated = await generatePostgresSchemas(ROOT, prefix);
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${quote(`${prefix}_state`)}`);
    await client.query(`SET LOCAL search_path = ${quote(`${prefix}_state`)}`);
    await client.query(generated.files["state.postgres.sql"]!);
    const remaining = [...generated.report.fragments];
    const applied = new Set<string>();
    while (remaining.length) {
      const next = remaining.findIndex((fragment) =>
        fragment.dependencies.every((id) => applied.has(id)),
      );
      if (next < 0) {
        throw new Error("Unresolved or cyclic lazy feature dependencies");
      }
      const [fragment] = remaining.splice(next, 1);
      await client.query(generated.files[fragment!.file]!);
      applied.add(fragment!.id);
    }
    await client.query(generated.files["state-v24-v25.postgres.sql"]!);
    await client.query("COMMIT");
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${quote(`${prefix}_agent`)}`);
    await client.query(`SET LOCAL search_path = ${quote(`${prefix}_agent`)}`);
    await client.query(generated.files["agent.postgres.sql"]!);
    await client.query("COMMIT");
    await verifyPostgres(generated.report.catalogs, async (sql) => {
      const row = (await client.query(sql)).rows[0];
      return row.catalog ?? row.triggers;
    });
    await checkStateTaskIndexMigration(
      client,
      `${prefix}_state`,
      generated.files["state-v23-v24.postgres.sql"]!,
    );
    console.log(
      `${prefix}_state: verified v23-to-v24 task index migration, retained payload, and complete index definitions`,
    );
    await client.query(`SET search_path = ${quote(`${prefix}_agent`)}`);
    await client.query("BEGIN");
    await client.query(`CREATE OR REPLACE FUNCTION openclaw_session_entry_snapshots_trigger()
      RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $broken$
      BEGIN UPDATE session_nodes SET snapshot_revision = snapshot_revision + 2
      WHERE session_key IN (OLD.session_key, NEW.session_key); RETURN NULL; END;
      $broken$`);
    await assert.rejects(
      () =>
        assertPostgresTriggers(
          generated.report.catalogs.agent!,
          async (sql) => (await client.query(sql)).rows[0].triggers,
        ),
      /trigger definitions differ/,
    );
    await client.query("ROLLBACK");
    await checkAgentPostgresBehavior(client);
    console.log(
      `Pending v22 promotions: ${pendingPromotion.map((entry) => entry.name).join(", ")}`,
    );
  } finally {
    await client.query("ROLLBACK");
    await client.query(`DROP SCHEMA IF EXISTS ${quote(`${prefix}_state`)} CASCADE`);
    await client.query(`DROP SCHEMA IF EXISTS ${quote(`${prefix}_agent`)} CASCADE`);
    await client.end();
  }
}

async function generateTeamReportsPostgresSchema(verify: boolean) {
  const { DatabaseSync } = await import("node:sqlite");
  using db = new DatabaseSync(":memory:");
  db.exec(TEAM_REPORTS_SCHEMA_SQL);
  const data = catalog(db, "");
  assert.equal(data.objects.filter((item) => item.sql === null).length, 0);
  const postgres = `${[
    "-- Generated by pnpm db:postgres:gen. Do not edit.",
    "-- The connection owner supplies search_path and the admission transaction.",
    ...tableStatements(data),
  ].join("\n\n")}\n`;
  const metadata = generateDatabasePortMetadata(db, data, {
    id: "team-reports",
    version: TEAM_REPORTS_SCHEMA_VERSION,
    sqlite: TEAM_REPORTS_SCHEMA_SQL,
    postgres,
  });
  for (const [file, content] of Object.entries({
    "extensions/team-reports/src/team-reports-schema.postgres.sql": postgres,
    "src/infra/database-engine/team-reports-port.generated.json": `${JSON.stringify(metadata, null, 2)}\n`,
  })) {
    if (verify) {
      assert.equal(
        fs.readFileSync(path.join(ROOT, file), "utf8"),
        content,
        `${file} is stale; run pnpm db:postgres:gen`,
      );
    } else {
      fs.writeFileSync(path.join(ROOT, file), content);
    }
  }
}

/** Agent port metadata references canonical DDL; only SQLite-only projections need column facts. */
function generateAgentPortMetadata(root: string, data: Catalog, postgres: string) {
  const sqlite = fs.readFileSync(path.join(root, "src/state/openclaw-agent-schema.sql"), "utf8");
  const db = new (process.getBuiltinModule("node:sqlite").DatabaseSync)(":memory:");
  try {
    db.exec(sqlite);
    const tables = portTables(data).map(({ name, identities }) => ({ name, identities }));
    const sqliteTables = db
      .prepare("PRAGMA table_list")
      .all()
      .filter((row) => row.type === "virtual" || row.type === "shadow")
      .map((row) => ({
        name: String(row.name),
        columns: db
          .prepare(`PRAGMA table_info(${quote(String(row.name))})`)
          .all()
          .map((column) => ({ name: String(column.name), type: String(column.type) })),
        pk: [],
        identities: [],
      }));
    const triggers = db
      .prepare("SELECT name, tbl_name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name")
      .all()
      .map((row) => {
        const start = sqlite.indexOf(`CREATE TRIGGER IF NOT EXISTS ${String(row.name)}`);
        const end = sqlite.indexOf("END;", start) + 4;
        assert.ok(start >= 0 && end > start);
        return { name: String(row.name), table: String(row.tbl_name), range: [start, end] };
      });
    return { tables, sqliteTables, triggers, ...postgresPortDataRanges(data, postgres) };
  } finally {
    db.close();
  }
}

/** Only copy ordering, allocation policy and DDL slices are port-owned metadata. */
function generateStatePortMetadata(
  root: string,
  data: Catalog,
  fragments: ReturnType<typeof listOpenClawStateFeatureSchemas>,
  files: Record<string, string>,
) {
  const sqlite = fs.readFileSync(path.join(root, "src/state/openclaw-state-schema.sql"), "utf8");
  const fragmentTables = new Set(fragments.flatMap((fragment) => fragment.tables));
  const schema = (tables: ReadonlySet<string>, postgres: string) => {
    const subset = {
      ...data,
      tables: data.tables.filter((table) => tables.has(table.name)),
      objects: data.objects.filter((item) => tables.has(item.table)),
    };
    return {
      tables: portTables(subset).map(({ name, identities }) => ({ name, identities })),
      ...postgresPortDataRanges(subset, postgres),
    };
  };
  const eager = new Set(
    data.tables.filter((table) => !fragmentTables.has(table.name)).map((table) => table.name),
  );
  const sqliteRanges = [...eager].map((table) => {
    const ddl = extractSqliteTableSchema(sqlite, table);
    const start = sqlite.indexOf(ddl);
    return [start, start + ddl.length];
  });
  for (const match of sqlite.matchAll(
    /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \w+\s+ON (\w+)[\s\S]*?;/g,
  )) {
    if (eager.has(match[1]!)) {
      sqliteRanges.push([match.index, match.index + match[0].length]);
    }
  }
  return {
    ...schema(eager, files["state.postgres.sql"]!),
    sqliteRanges,
    fragments: fragments.map((fragment) => ({
      id: fragment.id,
      ...schema(new Set(fragment.tables), files[`fragment-${fragment.id}.postgres.sql`]!),
    })),
  };
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const { values } = parseArgs({
    options: {
      target: { type: "string", default: "canonical" },
      out: { type: "string" },
      "schema-prefix": { type: "string", default: "openclaw" },
      "verify-psql": { type: "string" },
      "check-connection": { type: "string" },
      verify: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values["check-connection"]) {
    await checkPostgresCatalog(values["check-connection"]);
  } else if (values.help) {
    console.log(
      "Usage: pnpm db:postgres:gen [--out <dir>] [--schema-prefix openclaw] [--verify]\n       pnpm db:postgres:gen --target workboard [--verify]\n       pnpm db:postgres:gen --check-connection <dsn>\n--out also exports the diagnostic portability-report.json; default tracked outputs omit it.\n--verify-psql accepts a trusted psql shell command and expects eager DDL plus all fragments already applied.",
    );
  } else if (values.target === "workboard" || values.target === "logbook") {
    const target = values.target;
    if (values.out || values["verify-psql"]) {
      throw new Error(
        `The ${target} target writes its committed artifact; --out and --verify-psql are canonical-only`,
      );
    }
    const { sql, portMetadata } = await (target === "workboard"
      ? generateWorkboardPostgresSchema()
      : generateLogbookPostgresSchema());
    for (const [file, content] of Object.entries({
      [target === "workboard" ? WORKBOARD_OUTPUT : LOGBOOK_OUTPUT]: sql,
      [target === "workboard" ? WORKBOARD_PORT_OUTPUT : LOGBOOK_PORT_OUTPUT]:
        `${JSON.stringify(portMetadata, null, 2)}\n`,
    })) {
      const output = path.join(ROOT, file);
      if (values.verify) {
        if (fs.readFileSync(output, "utf8") !== content) {
          throw new Error(`${file} is stale; run pnpm db:postgres:gen --target ${target}`);
        }
        console.log(`${file}: up to date`);
      } else {
        fs.writeFileSync(output, content);
        console.log(`Generated ${file}`);
      }
    }
  } else {
    if (values.target !== "canonical") {
      throw new Error("Use --target canonical, --target workboard or --target logbook");
    }
    const out = values.out ?? path.join(ROOT, OUTPUT);
    const result = await generatePostgresSchemas(ROOT, values["schema-prefix"], {
      includeJsonReport: values.out !== undefined,
    });
    if (!values.verify) {
      fs.mkdirSync(out, { recursive: true });
    }
    if (values.verify) {
      assert.deepEqual(
        fs.readdirSync(out).toSorted(),
        Object.keys(result.files).toSorted(),
        "Generated PostgreSQL artifact inventory is stale",
      );
    }
    for (const [name, content] of Object.entries(result.files)) {
      if (values.verify) {
        assert.equal(
          fs.readFileSync(path.join(out, name), "utf8"),
          content,
          `${name} is stale; run pnpm db:postgres:gen`,
        );
      } else {
        fs.writeFileSync(path.join(out, name), content);
      }
    }
    console.log(JSON.stringify(result.report.summary, null, 2));
    if (!values.out) {
      await generateTeamReportsPostgresSchema(Boolean(values.verify));
    }
    if (values["verify-psql"]) {
      await verifyPostgres(result.report.catalogs, async (sql) =>
        JSON.parse(
          execSync(`${values["verify-psql"]} -X -qAt -v ON_ERROR_STOP=1`, {
            input: sql,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
          }),
        ),
      );
    }
  }
}
