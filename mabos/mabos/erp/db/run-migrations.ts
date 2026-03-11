import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getErpPgPool, query, closeErpPgPool } from "./postgres.js";

async function runMigrations(): Promise<void> {
  const pg = getErpPgPool();

  await query(
    pg,
    `
    CREATE TABLE IF NOT EXISTS erp_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `,
  );

  const applied = new Set(
    (await query<{ filename: string }>(pg, "SELECT filename FROM erp_migrations ORDER BY id")).map(
      (r) => r.filename,
    ),
  );

  const migrationsDir = join(import.meta.dirname ?? ".", "migrations");
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(migrationsDir, file), "utf-8");
    console.log(`Applying: ${file}`);
    await query(pg, sql);
    await query(pg, "INSERT INTO erp_migrations (filename) VALUES ($1)", [file]);
    count++;
  }

  console.log(count > 0 ? `Applied ${count} migrations.` : "No pending migrations.");
  await closeErpPgPool();
}

runMigrations().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
