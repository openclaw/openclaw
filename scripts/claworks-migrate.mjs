#!/usr/bin/env node
/**
 * Apply ClaWorks PostgreSQL schema.
 * Usage: CLAWORKS_DATABASE_URL=postgresql://user:pass@host/db pnpm claworks:migrate
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.CLAWORKS_DATABASE_URL?.trim();
if (!url || (!url.startsWith("postgresql://") && !url.startsWith("postgres://"))) {
  console.error("Set CLAWORKS_DATABASE_URL=postgresql://...");
  process.exit(1);
}

let pg;
try {
  pg = (await import("pg")).default;
} catch {
  console.error("Install optional dependency: pnpm add -w pg");
  process.exit(1);
}

const sqlPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages/claworks-runtime/src/planes/data/drizzle/migrations/0000_init.sql",
);
const sql = await readFile(sqlPath, "utf8");
const pool = new pg.Pool({ connectionString: url });

try {
  await pool.query(sql);
  console.log("ClaWorks PostgreSQL schema applied from 0000_init.sql");
} finally {
  await pool.end();
}
