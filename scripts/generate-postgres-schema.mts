#!/usr/bin/env node

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { catalog, literal, quote, type Catalog } from "./lib/postgres-schema-catalog.mts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export async function generatePostgresSchemas(root = ROOT, prefix = "openclaw") {
  if (!prefix || Buffer.byteLength(`${prefix}_state`) > 63 || prefix.includes("\0")) {
    throw new Error("Schema prefix must fit PostgreSQL's 63-byte identifier limit");
  }
  const { DatabaseSync } = await import("node:sqlite");
  const catalogs: Record<string, Catalog> = {};
  const files: Record<string, string> = {};
  for (const name of ["state", "agent"]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(fs.readFileSync(path.join(root, `src/state/openclaw-${name}-schema.sql`), "utf8"));
      catalogs[name] = catalog(db, `${prefix}_${name}`);
    } finally {
      db.close();
    }
    const data = catalogs[name]!;
    const statements = [
      "-- Generated from canonical SQLite; consult portability-report.json before use.",
      "BEGIN;",
      "SET LOCAL standard_conforming_strings = on;",
      `CREATE SCHEMA ${quote(data.schema)};`,
    ];
    for (const kind of ["table", "index", "foreignKey"]) {
      statements.push(
        ...data.objects
          .filter(
            (item) =>
              item.kind === kind && item.sql && (kind !== "index" || item.sql.startsWith("CREATE")),
          )
          .map((item) => item.sql!),
      );
    }
    files[`${name}.postgres.sql`] = `${statements.join("\n\n")}\n\nCOMMIT;\n`;
  }
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
    "Agent topology remains undecided: schema per agent versus shared tables. The agent output represents one canonical database only.",
    "Text uses C collation. PostgreSQL text rejects NUL; SQLite length(text) stops at NUL. Data validation and numeric/JSON representation differences need a separate migration contract.",
    "STRICT and WITHOUT ROWID options are removed. Identity sequences do not reproduce SQLite rowid/AUTOINCREMENT/sqlite_sequence allocation or rollback semantics; each rowid alias adds a PostgreSQL PK index absent from SQLite's index_list.",
    "Not covered: runtime-created memory FTS5 in packages/memory-host-sdk/src/host/memory-schema-fts.ts; vec0 in extensions/memory-core/src/memory/manager-sync-base.ts and src/migration/doctor-memory-sidecar-import.ts.",
    "Not covered: plugin-owned databases, including extensions/workboard/src/sqlite-store-schema.ts, extensions/logbook/src/store-schema.ts and extensions/team-reports/src/store-schema.ts.",
    "Not covered: additive/startup repair DDL in src/state/*-schema.ts and *migration*.ts, including openclaw-agent-transcript-fts-schema.ts, openclaw-agent-board-schema.ts and openclaw-agent-canonical-validation-migration.ts.",
  ];
  const report = { summary, limitations, catalogs };
  files["portability-report.json"] = `${JSON.stringify(report, null, 2)}\n`;
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
        `- ${item.kind} \`${item.table}.${item.name}\`: ${item.reason}${item.category ? `; ${item.category}; ${item.design}` : ""}. Source: \`${item.source.replaceAll("`", "\\`").replaceAll("\n", " ")}\``,
      );
    }
  }
  files["portability-report.md"] = `${markdown.join("\n")}\n`;
  return { files, report };
}

function verifyPostgres(catalogs: Record<string, Catalog>, command: string): void {
  const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) => {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        return Object.fromEntries(
          Object.entries(item).toSorted(([a], [b]) => a.localeCompare(b, "en")),
        );
      }
      return item;
    });
  for (const data of Object.values(catalogs)) {
    const expected: unknown[] = [];
    const add = (table: string, kind: string, value: unknown) =>
      expected.push({ table, kind, value });
    for (const table of data.tables) {
      add(table.name, "table", null);
      for (const [position, column] of table.columns.entries()) {
        add(table.name, "column", { ...column, position: position + 1 });
      }
      if (table.pk.length) {
        add(table.name, "primaryKey", table.pk);
      }
      for (const unique of table.unique) {
        add(table.name, "unique", unique);
      }
      for (const fk of table.foreignKeys) {
        add(table.name, "foreignKey", fk);
      }
      add(table.name, "indexes", table.indexes);
      add(
        table.name,
        "checks",
        data.objects.filter(
          (item) => item.table === table.name && item.kind === "check" && item.sql,
        ).length,
      );
    }
    const columns = (relation: string, keys: string) =>
      `(SELECT jsonb_agg(a.attname ORDER BY k.ordinality) FROM unnest(${keys}) WITH ORDINALITY k(num, ordinality) JOIN pg_attribute a ON a.attrelid = ${relation} AND a.attnum = k.num)`;
    const action = (field: string) =>
      `CASE ${field} WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END`;
    const query = `WITH relations AS (
      SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${literal(data.schema)} AND c.relkind IN ('r', 'p')
    ), facts AS (
      SELECT r.relname AS "table", 'table' AS kind, 'null'::jsonb AS value FROM relations r
      UNION ALL SELECT r.relname, 'column', jsonb_build_object(
        'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
        'nullable', NOT a.attnotnull, 'identity', a.attidentity = 'd', 'position', a.attnum)
        FROM relations r JOIN pg_attribute a ON a.attrelid = r.oid WHERE a.attnum > 0 AND NOT a.attisdropped
      UNION ALL SELECT r.relname, CASE c.contype WHEN 'p' THEN 'primaryKey' ELSE 'unique' END,
        ${columns("r.oid", "c.conkey")} FROM relations r JOIN pg_constraint c ON c.conrelid = r.oid WHERE c.contype IN ('p', 'u')
      UNION ALL SELECT r.relname, 'foreignKey', jsonb_build_object(
        'columns', ${columns("r.oid", "c.conkey")}, 'target', target.relname,
        'targetColumns', ${columns("c.confrelid", "c.confkey")},
        'onUpdate', ${action("c.confupdtype")}, 'onDelete', ${action("c.confdeltype")},
        'deferrable', c.condeferrable, 'deferred', c.condeferred)
        FROM relations r JOIN pg_constraint c ON c.conrelid = r.oid
        JOIN pg_class target ON target.oid = c.confrelid WHERE c.contype = 'f'
      UNION ALL SELECT r.relname, 'indexes', to_jsonb((SELECT count(*) FROM pg_index i WHERE i.indrelid = r.oid)) FROM relations r
      UNION ALL SELECT r.relname, 'checks', to_jsonb((SELECT count(*) FROM pg_constraint c WHERE c.conrelid = r.oid AND c.contype = 'c')) FROM relations r
    ) SELECT coalesce(jsonb_agg(facts), '[]'::jsonb) FROM facts;`;
    // The operator supplies the trusted psql shell command; SQL is sent on stdin.
    const actual: unknown = JSON.parse(
      execSync(`${command} -X -qAt -v ON_ERROR_STOP=1`, {
        input: query,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      }),
    );
    assert.ok(Array.isArray(actual), "psql must return a JSON catalog array");
    assert.deepStrictEqual(
      actual.map(canonical).toSorted(),
      expected.map(canonical).toSorted(),
      `${data.schema}: unexplained PostgreSQL catalog differences`,
    );
    console.log(
      `${data.schema}: verified ${data.tables.length} tables; zero unexplained differences (columns/types/nullability/identity, PK, UNIQUE, FKs/actions/deferrability, index and CHECK counts)`,
    );
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      "schema-prefix": { type: "string", default: "openclaw" },
      "verify-psql": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      'Usage: node scripts/generate-postgres-schema.mts --out <dir> [--schema-prefix openclaw] [--verify-psql "psql -U postgres"]\nApply both generated SQL files before verification. The psql command is trusted shell input.',
    );
  } else {
    if (!values.out) {
      throw new Error("--out <dir> is required; no files are written by default");
    }
    const result = await generatePostgresSchemas(ROOT, values["schema-prefix"]);
    fs.mkdirSync(values.out, { recursive: true });
    for (const [name, content] of Object.entries(result.files)) {
      fs.writeFileSync(path.join(values.out, name), content);
    }
    console.log(JSON.stringify(result.report.summary, null, 2));
    if (values["verify-psql"]) {
      verifyPostgres(result.report.catalogs, values["verify-psql"]);
    }
  }
}
