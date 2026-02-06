#!/usr/bin/env bun
/**
 * Read-only PostgreSQL query script for text2sql skill.
 * Commands: list_tables | schema --table T | sample --table T [--limit N] | query --sql "SELECT ..." [--limit N]
 */

import { Client } from "pg";
import { isReadOnlySelect } from "./readonly-validator";

const VALID_CMDS = ["list_tables", "schema", "sample", "query"] as const;

function parseArgs(argv: string[]): {
  cmd: (typeof VALID_CMDS)[number];
  table?: string;
  limit?: number;
  sql?: string;
} {
  const args = argv.slice(2);
  const cmd = args[0];
  if (!cmd || !VALID_CMDS.includes(cmd as (typeof VALID_CMDS)[number])) {
    console.error(
      'Usage: query list_tables | schema --table T | sample --table T [--limit N] | query --sql "SELECT ..." [--limit N]',
    );
    process.exit(1);
  }
  const result: {
    cmd: (typeof VALID_CMDS)[number];
    table?: string;
    limit?: number;
    sql?: string;
  } = { cmd: cmd as (typeof VALID_CMDS)[number] };

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--table" && args[i + 1]) {
      result.table = args[++i];
    } else if (args[i] === "--limit" && args[i + 1]) {
      const n = Number.parseInt(args[i + 1], 10);
      if (Number.isNaN(n) || n < 1) {
        console.error("--limit must be a positive integer");
        process.exit(1);
      }
      result.limit = n;
      i++;
    } else if (args[i] === "--sql" && args[i + 1]) {
      result.sql = args[++i];
    }
  }

  if ((result.cmd === "schema" || result.cmd === "sample") && !result.table) {
    console.error(`${result.cmd} requires --table <name>`);
    process.exit(1);
  }
  if (result.cmd === "query" && !result.sql) {
    console.error('query requires --sql "SELECT ..."');
    process.exit(1);
  }

  return result;
}

function parseTableArg(tableArg: string): { schema: string; table: string } {
  const dot = tableArg.indexOf(".");
  if (dot >= 0) {
    return { schema: tableArg.slice(0, dot), table: tableArg.slice(dot + 1) };
  }
  return { schema: "public", table: tableArg };
}

function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

async function runListTables(client: Client): Promise<void> {
  const res = await client.query<{ table_schema: string; table_name: string }>(
    `SELECT table_schema, table_name
     FROM information_schema.tables
     WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
     ORDER BY table_schema, table_name`,
  );
  for (const row of res.rows) {
    const name =
      row.table_schema === "public" ? row.table_name : `${row.table_schema}.${row.table_name}`;
    console.log(name);
  }
}

async function runSchema(client: Client, tableArg: string): Promise<void> {
  const { schema, table } = parseTableArg(tableArg);
  const res = await client.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schema, table],
  );
  if (res.rows.length === 0) {
    console.error(`Table not found: ${tableArg}`);
    process.exit(1);
  }
  console.log("column_name,data_type");
  for (const row of res.rows) {
    console.log(`${escapeCsv(row.column_name)},${escapeCsv(row.data_type)}`);
  }
}

const SAMPLE_LIMIT_MAX = 10;
const QUERY_LIMIT_DEFAULT = 500;
const QUERY_LIMIT_MAX = 1000;

function quoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function rowsToCsv(fields: { name: string }[], rows: Record<string, unknown>[]): void {
  if (fields.length === 0) return;
  console.log(fields.map((f) => escapeCsv(f.name)).join(","));
  for (const row of rows) {
    const values = fields.map((f) => {
      const v = row[f.name];
      return v === null || v === undefined ? "" : String(v);
    });
    console.log(values.map(escapeCsv).join(","));
  }
}

async function runSample(client: Client, tableArg: string, limit: number): Promise<void> {
  const { schema, table } = parseTableArg(tableArg);
  const n = Math.min(Math.max(1, limit), SAMPLE_LIMIT_MAX);
  const sql = `SELECT * FROM ${quoteId(schema)}.${quoteId(table)} LIMIT ${n}`;
  const res = await client.query(sql);
  if (res.fields && res.fields.length > 0) {
    rowsToCsv(
      res.fields.map((f) => ({ name: f.name })),
      res.rows as Record<string, unknown>[],
    );
  }
}

async function runQuery(client: Client, sql: string, limit: number): Promise<void> {
  const capped = Math.min(Math.max(1, limit), QUERY_LIMIT_MAX);
  const normalized = sql.trimEnd().replace(/;\s*$/, "");
  const limitMatch = normalized.match(/LIMIT\s+(\d+)(\s+OFFSET\s+\d+)?\s*$/i);
  let finalSql: string;
  if (limitMatch) {
    const existing = Number(limitMatch[1]);
    const effectiveLimit = Math.min(existing, capped);
    const offsetPart = limitMatch[2] ?? "";
    finalSql = normalized.replace(
      /LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/i,
      `LIMIT ${effectiveLimit}${offsetPart}`,
    );
  } else {
    finalSql = `${normalized} LIMIT ${capped}`;
  }
  const res = await client.query({ text: finalSql, rowMode: "object" });
  const fields = res.fields ?? [];
  if (fields.length > 0) {
    rowsToCsv(
      fields.map((f) => ({ name: f.name })),
      res.rows as Record<string, unknown>[],
    );
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Set it to a read-only PostgreSQL connection string.");
    process.exit(1);
  }

  const opts = parseArgs(process.argv);

  // Reject non-SELECT before connecting (so we can test without a real DB).
  if (opts.cmd === "query" && opts.sql && !isReadOnlySelect(opts.sql)) {
    console.error("Only SELECT queries are allowed. Rejected.");
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();
    if (opts.cmd === "list_tables") {
      await runListTables(client);
    } else if (opts.cmd === "schema" && opts.table) {
      await runSchema(client, opts.table);
    } else if (opts.cmd === "sample" && opts.table) {
      await runSample(client, opts.table, opts.limit ?? 1);
    } else if (opts.cmd === "query" && opts.sql) {
      await runQuery(client, opts.sql, opts.limit ?? QUERY_LIMIT_DEFAULT);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
