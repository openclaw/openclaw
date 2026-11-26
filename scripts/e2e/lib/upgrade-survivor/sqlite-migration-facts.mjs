import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  readSqliteTranscriptPayload,
  sqliteTranscriptPayloadColumns,
} from "../../../lib/sqlite-transcript-payload.mjs";

export const MIN_MIGRATION_BYTES = 10 * 1024 ** 3;
export const MIGRATION_SCHEMA_BUDGET_MS = 10_000;
export const MIGRATION_COPY_BUDGET_MS = 10 * 60_000;

export function readOccupiedSqliteBytes(file) {
  using db = new DatabaseSync(file, { readOnly: true });
  return (
    (Number(db.prepare("PRAGMA page_count").get().page_count) -
      Number(db.prepare("PRAGMA freelist_count").get().freelist_count)) *
    Number(db.prepare("PRAGMA page_size").get().page_size)
  );
}

export function readMigrationFileFacts(file) {
  using db = new DatabaseSync(file, { readOnly: true });
  const stat = fs.statSync(file);
  const pageSize = Number(db.prepare("PRAGMA page_size").get().page_size);
  const pageCount = Number(db.prepare("PRAGMA page_count").get().page_count);
  const freePages = Number(db.prepare("PRAGMA freelist_count").get().freelist_count);
  const wal = fs.statSync(`${file}-wal`, { throwIfNoEntry: false });
  return {
    path: file,
    schemaVersion: Number(db.prepare("PRAGMA user_version").get().user_version),
    pageSize,
    pageCount,
    freePages,
    occupiedBytes: (pageCount - freePages) * pageSize,
    fileBytes: stat.size,
    allocatedBytes: stat.blocks * 512,
    walBytes: wal?.size ?? 0,
  };
}

export function assertMigrationVolume(facts) {
  assert(
    facts.occupiedBytes >= MIN_MIGRATION_BYTES,
    "Fixture has less than 10 GiB occupied SQLite data",
  );
  assert.equal(facts.walBytes, 0, "Baseline writer did not close with an empty WAL");
  assert(facts.fileBytes >= facts.occupiedBytes, "Occupied pages still depend on the WAL");
  assert(
    facts.allocatedBytes >= facts.occupiedBytes,
    "Fixture SQLite data is not physically allocated",
  );
}

export function readMigrationFilesystem(directory) {
  const real = fs.realpathSync(directory);
  const stat = fs.statfsSync(real);
  const mount = fs
    .readFileSync("/proc/self/mountinfo", "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const [fields, filesystem] = line.split(" - ");
      const mountPoint = fields.split(" ")[4];
      return { mountPoint, type: filesystem.split(" ")[0] };
    })
    .filter(
      ({ mountPoint }) =>
        mountPoint === "/" || real === mountPoint || real.startsWith(`${mountPoint}/`),
    )
    .toSorted((a, b) => b.mountPoint.length - a.mountPoint.length)[0];
  assert(mount, "Cannot identify the fixture filesystem");
  return {
    ...mount,
    typeMagic: `0x${stat.type.toString(16)}`,
    availableBytes: stat.bavail * stat.bsize,
  };
}

export function readMigrationRows(fixture, witnesses) {
  using agent = new DatabaseSync(fixture.agentPath, { readOnly: true });
  using shared = new DatabaseSync(fixture.statePath, { readOnly: true });
  const session = agent
    .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
    .get(witnesses.sessionKey);
  assert.equal(session?.current_session_id, witnesses.sessionId, "Seeded session identity changed");
  const transcript = witnesses.transcript.map(({ eventId, textSha256 }) => {
    const row = agent
      .prepare(`
      SELECT ${sqliteTranscriptPayloadColumns(agent)}
      FROM transcript_events AS events
      JOIN transcript_event_identities AS identities USING (session_id, seq)
      WHERE identities.session_id = ? AND identities.event_id = ?
    `)
      .get(witnesses.sessionId, eventId);
    assert(row, `Missing seeded transcript event ${eventId}`);
    const event = JSON.parse(readSqliteTranscriptPayload(row));
    const text = event.message.content.filter((part) => part.type === "text");
    assert.equal(text.length, 1, "Seeded message text shape changed");
    const actual = createHash("sha256").update(text[0].text).digest("hex");
    assert.equal(actual, textSha256, "Seeded transcript content changed");
    assert.equal(event.id, eventId, "Seeded transcript identity changed");
    return { eventId, textSha256: actual };
  });
  const sentinel = shared
    .prepare(`
    SELECT value_json FROM plugin_state_entries
    WHERE plugin_id = ? AND namespace = ? AND entry_key = ?
  `)
    .get(witnesses.shared.pluginId, witnesses.shared.namespace, witnesses.shared.key);
  assert(sentinel, "Missing baseline shared-state sentinel");
  const value = JSON.parse(sentinel.value_json);
  assert.deepEqual(value, witnesses.shared.value, "Shared-state sentinel changed");
  return {
    sessions: Number(
      agent
        .prepare("SELECT count(*) AS n FROM session_nodes WHERE session_key = ?")
        .get(witnesses.sessionKey).n,
    ),
    transcriptEvents: Number(
      agent
        .prepare("SELECT count(*) AS n FROM transcript_events WHERE session_id = ?")
        .get(witnesses.sessionId).n,
    ),
    sharedEntries: Number(
      shared
        .prepare("SELECT count(*) AS n FROM plugin_state_entries WHERE plugin_id = ?")
        .get(witnesses.shared.pluginId).n,
    ),
    transcript,
    shared: value,
  };
}

/** Copy calls are serial in the owner; overlap must not make subtraction hide schema work. */
export function classifyMigrationTiming(elapsedMs, copies) {
  assert(Number.isFinite(elapsedMs) && elapsedMs >= 0, "Invalid startup elapsed time");
  let end = 0;
  let copyMs = 0;
  for (const copy of copies) {
    assert(copy.startedMs >= end, "Overlapping copy intervals cannot be subtracted");
    assert(
      copy.endedMs >= copy.startedMs && copy.endedMs <= elapsedMs,
      "Invalid copy timing interval",
    );
    copyMs += copy.endedMs - copy.startedMs;
    end = copy.endedMs;
  }
  const schemaMs = elapsedMs - copyMs;
  return {
    elapsedMs,
    schemaMs,
    copyMs,
    schemaBudgetMs: MIGRATION_SCHEMA_BUDGET_MS,
    copyBudgetMs: MIGRATION_COPY_BUDGET_MS,
    passed: schemaMs <= MIGRATION_SCHEMA_BUDGET_MS && copyMs <= MIGRATION_COPY_BUDGET_MS,
  };
}
