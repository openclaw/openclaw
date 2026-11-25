/** Expand an owned synthetic seed with hot sibling sessions; never opens operator state. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const root = path.resolve(process.argv[2]);
const sessions = Number(process.argv[3] ?? 2400);
const events = 2500;
const manifestPath = path.join(root, "fixture.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
assert(manifest.sessions === 1 && manifest.eventsPerSession === 50000 && !manifest.padding);
const db = new DatabaseSync(path.join(root, "agent.sqlite"));
assert.equal(db.prepare("SELECT count(*) AS n FROM session_windows").get().n, 1);
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
const quote = (name) => `"${name}"`;
const clone = (table, overrides, where) => {
  const columns = db
    .prepare(`PRAGMA table_info(${quote(table)})`)
    .all()
    .map((column) => column.name);
  return db.prepare(
    `INSERT INTO ${quote(table)} (${columns.map(quote).join(",")}) SELECT ${columns.map((column) => overrides[column] ?? quote(column)).join(",")} FROM ${quote(table)} WHERE ${where}`,
  );
};
const node = clone(
  "session_nodes",
  {
    session_key: "$key",
    current_session_id: "$id",
    updated_at: "$now",
    entry_json: "json_set(entry_json,'$.sessionId',$id,'$.updatedAt',$now)",
  },
  "session_key='agent:main:synthetic-0'",
);
const window = clone(
  "session_windows",
  {
    session_id: "$id",
    session_key: "$key",
    updated_at: "$now",
    transcript_updated_at: "$now",
  },
  "session_id='synthetic-0'",
);
const copies = [
  clone("transcript_events", { session_id: "$id" }, `session_id='synthetic-0' AND seq<${events}`),
  clone(
    "transcript_event_identities",
    { session_id: "$id" },
    `session_id='synthetic-0' AND seq<${events}`,
  ),
  clone(
    "session_transcript_active_events",
    { session_id: "$id" },
    `session_id='synthetic-0' AND event_seq<${events}`,
  ),
  clone(
    "session_transcript_index_state",
    {
      session_id: "$id",
      indexed_seq: String(events - 1),
      leaf_event_id: `'event-${events - 1}'`,
      active_event_count: String(events),
      active_message_count: String(events),
    },
    "session_id='synthetic-0'",
  ),
  clone(
    "transcript_rewrite_watermarks",
    { session_id: "$id", generation: "$id" },
    "session_id='synthetic-0'",
  ),
];
const ftsMap = db.prepare(
  `INSERT INTO session_transcript_fts_rows(id,session_id,message_id) SELECT id+$offset,$id,message_id FROM session_transcript_fts_rows WHERE session_id='synthetic-0' AND id<=${events}`,
);
const fts = db.prepare(
  `INSERT INTO session_transcript_fts(rowid,text,session_id,message_id,role,timestamp) SELECT rowid+$offset,text,$id,message_id,role,timestamp FROM session_transcript_fts WHERE rowid<=${events}`,
);
const started = performance.now();
for (let index = 0; index < sessions; index++) {
  const id = `padding-${index}`,
    key = `agent:main:${id}`,
    now = Date.now();
  const offset = 50000 + index * events;
  db.exec("BEGIN IMMEDIATE");
  try {
    node.run({ key, id, now });
    window.run({ key, id, now });
    for (const copy of copies) {
      copy.run({ id });
    }
    ftsMap.run({ id, offset });
    fts.run({ id, offset });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (index % 100 === 99) {
    console.error(JSON.stringify({ sessions: index + 1, elapsedMs: performance.now() - started }));
  }
}
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
manifest.padding = {
  sessions,
  eventsPerSession: events,
  databaseBytes: fs.statSync(path.join(root, "agent.sqlite")).size,
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest));
console.log(JSON.stringify({ padding: manifest.padding, elapsedMs: performance.now() - started }));
db.close();
