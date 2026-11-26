/**
 * Seed a storage-shaped, synthetic audit fixture from audit-batch-write-measure's
 * small fresh database. Never pass a real database. The 100k/100k/250k/200k rows
 * and 12KB identity/decision payloads defeat SQLite's default private page cache.
 * Payload filler exercises storage layout; it is not an inspectable audit record.
 * New benchmark writes still traverse the real writer with valid audit inputs.
 *
 * node scripts/perf/audit-retention-fixture.mjs <synthetic-source.sqlite> <new-output.sqlite>
 */
import assert from "node:assert/strict";
import { constants, copyFileSync, existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [source, output] = process.argv.slice(2);
assert(source && output && !existsSync(output), "provide a synthetic source and new output");
copyFileSync(source, output, constants.COPYFILE_FICLONE);
const db = new DatabaseSync(output);
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
const families = [
  ["audit_events", 100_000, undefined],
  ["execution_identity_contexts", 100_000, "context"],
  ["execution_decision_facts", 250_000, "receipt"],
  ["outbound_message_progress", 200_000, undefined],
];
const now = Math.floor(Date.now() / 86_400_000) * 86_400_000;
for (const [table, count, payload] of families) {
  const template = db.prepare(`SELECT * FROM ${table} LIMIT 1`).get();
  assert(template, `source needs a synthetic ${table} row`);
  delete template.sequence;
  const columns = Object.keys(template);
  const insert = db.prepare(
    `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
  );
  db.exec(`BEGIN; DELETE FROM ${table};`);
  for (let i = 0; i < count; i++) {
    const row = { ...template };
    for (const column of [
      "event_id",
      "context_id",
      "execution_id",
      "receipt_id",
      "source_id",
      "progress_id",
    ]) {
      if (column in row) {
        row[column] = `synthetic-${column}-${String(i).padStart(7, "0")}`;
      }
    }
    if ("cursor_id" in row) {
      row.cursor_id = i + 1;
    }
    if ("run_id" in row) {
      row.run_id = `synthetic-run-${i % 5_000}`;
    }
    if ("session_key" in row) {
      row.session_key = `agent:synthetic:session-${i % 5_000}`;
    }
    if ("created_at" in row) {
      row.created_at = now - 1_000_000 + i;
    }
    if ("occurred_at" in row) {
      row.occurred_at = now - 1_000_000 + i;
    }
    if ("actor_id" in row) {
      row.actor_id = `synthetic-${"x".repeat(100)}`;
    }
    if (payload) {
      row[`${payload}_json`] = JSON.stringify({ synthetic: "x".repeat(12_000) });
      row[`${payload}_bytes`] = Buffer.byteLength(row[`${payload}_json`]);
    }
    insert.run(...columns.map((column) => row[column]));
    if (i % 10_000 === 9_999) {
      db.exec("COMMIT; BEGIN");
    }
  }
  db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE);");
  console.log(JSON.stringify({ table, count, databaseBytes: statSync(output).size }));
}
db.exec("ANALYZE; PRAGMA wal_checkpoint(TRUNCATE);");
db.close();
