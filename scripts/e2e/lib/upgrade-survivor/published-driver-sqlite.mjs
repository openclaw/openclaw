import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  readSqliteTranscriptPayload,
  sqliteTranscriptPayloadColumns,
} from "../../../lib/sqlite-transcript-payload.mjs";

const retained = "published update keeps π \0 雪";
const event = JSON.stringify({
  type: "message",
  id: "reclamation-kept",
  message: { role: "assistant", content: [{ type: "text", text: "saffronquasar 雪" }] },
});
const sessionId = "published-driver-reclamation";

function rowMapIdentity(database) {
  const columns = database.prepare("PRAGMA table_info(session_transcript_fts_rows)").all();
  const names = columns.map((column) => column.name);
  if (names.includes("id") && names.includes("message_id")) {
    return { columns, id: "id", current: true };
  }
  assert.deepEqual(names, ["session_id", "fts_rowid"], "Unknown transcript row-map schema");
  return { columns, id: "fts_rowid", current: false };
}

export function publishedDriverSqliteTargets(state) {
  return [
    { role: "global", path: path.join(state, "state/openclaw.sqlite") },
    ...["main", "second"].map((agentId) => ({
      role: "agent",
      agentId,
      path: path.join(state, "agents", agentId, "agent/openclaw-agent.sqlite"),
    })),
  ];
}

/** The fixture calls this before installing or starting the baseline service. */
export function seedPublishedDriverLegacySqlite(state) {
  assert.equal(state, "/home/appuser/.openclaw");
  const seededAt = Date.now();
  for (const target of publishedDriverSqliteTargets(state)) {
    assert(fs.statSync(target.path).isFile(), `Doctor did not prepare ${target.path}`);
    const database = new DatabaseSync(target.path);
    try {
      database.exec(`PRAGMA auto_vacuum=NONE; VACUUM;
        CREATE TABLE published_driver_retained(id INTEGER PRIMARY KEY, value TEXT);
        CREATE TABLE published_driver_discarded(id INTEGER PRIMARY KEY, value BLOB);
        INSERT INTO published_driver_discarded VALUES(42,zeroblob(4194304));
        DELETE FROM published_driver_discarded;`);
      database.prepare("INSERT INTO published_driver_retained VALUES(41,?)").run(retained);
      if (target.agentId) {
        const rowMap = rowMapIdentity(database);
        const key = `agent:${target.agentId}:reclamation`;
        database
          .prepare(`INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at)
          VALUES(?,?,?,?)`)
          .run(key, sessionId, JSON.stringify({ sessionId, updatedAt: seededAt }), seededAt);
        database
          .prepare(`INSERT INTO session_windows(session_id,session_key,created_at,updated_at)
          VALUES(?,?,?,?)`)
          .run(sessionId, key, seededAt, seededAt);
        database
          .prepare(`INSERT INTO transcript_events(rowid,session_id,seq,event_json,created_at)
          VALUES(41,?,7,?,?)`)
          .run(sessionId, event, seededAt);
        database
          .prepare(`INSERT INTO session_transcript_fts(rowid,text,session_id,message_id,role,timestamp)
          VALUES(-17,'saffronquasar 雪',?,'reclamation-kept','assistant',?)`)
          .run(sessionId, new Date(seededAt).toISOString());
        database
          .prepare(
            rowMap.current
              ? "INSERT INTO session_transcript_fts_rows(id,session_id,message_id) VALUES(-17,?,'reclamation-kept')"
              : "INSERT INTO session_transcript_fts_rows(fts_rowid,session_id) VALUES(-17,?)",
          )
          .run(sessionId);
      }
      assert.equal(database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get().busy, 0);
    } finally {
      database.close();
    }
  }
  return inspectPublishedDriverSqlite(state, 0);
}

/** Independent SQLite reads preserve the baseline/candidate storage contract. */
export function inspectPublishedDriverSqlite(state, expectedMode) {
  const observations = [];
  for (const target of publishedDriverSqliteTargets(state)) {
    const database = new DatabaseSync(target.path, { readOnly: true });
    try {
      const mode = database.prepare("PRAGMA auto_vacuum").get().auto_vacuum;
      assert.equal(mode, expectedMode, `${target.path} reclamation mode`);
      assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
      const values = database
        .prepare(
          "SELECT id,value,hex(CAST(value AS BLOB)) AS bytes FROM published_driver_retained ORDER BY id",
        )
        .all();
      const discarded = database
        .prepare("SELECT id FROM published_driver_discarded ORDER BY id")
        .all();
      assert.deepEqual(discarded, [], "Deleted fixture rows returned");
      assert.deepEqual(
        values.map(({ id, value }) => ({ id, value })),
        [{ id: 41, value: retained }],
      );
      let transcript;
      let matches;
      let rowMap;
      let schema;
      let sessions;
      if (target.agentId) {
        const identity = rowMapIdentity(database);
        schema = {
          transcriptColumns: database.prepare("PRAGMA table_info(transcript_events)").all(),
          rowMapColumns: identity.columns,
        };
        sessions = database
          .prepare(`SELECT node.session_key,node.current_session_id,window.session_id
          FROM session_nodes AS node JOIN session_windows AS window
          ON window.session_id=node.current_session_id AND window.session_key=node.session_key
          WHERE node.session_key=? ORDER BY node.session_key`)
          .all(`agent:${target.agentId}:reclamation`);
        assert.deepEqual(sessions, [
          {
            session_key: `agent:${target.agentId}:reclamation`,
            current_session_id: sessionId,
            session_id: sessionId,
          },
        ]);
        const rows = database
          .prepare(`SELECT rowid,seq,${sqliteTranscriptPayloadColumns(database)}
          FROM transcript_events WHERE session_id=? ORDER BY seq,rowid`)
          .all(sessionId);
        transcript = rows.map((row) => ({
          rowid: row.rowid,
          seq: row.seq,
          event: readSqliteTranscriptPayload(row),
        }));
        assert.deepEqual(transcript, [{ rowid: 41, seq: 7, event }]);
        matches = database
          .prepare(`SELECT rowid,text,session_id,message_id FROM session_transcript_fts
          WHERE session_transcript_fts MATCH 'saffronquasar' AND session_id=? ORDER BY rowid`)
          .all(sessionId);
        assert.deepEqual(matches, [
          {
            rowid: -17,
            text: "saffronquasar 雪",
            session_id: sessionId,
            message_id: "reclamation-kept",
          },
        ]);
        rowMap = database
          .prepare(
            `SELECT ${identity.id} AS rowid,session_id FROM session_transcript_fts_rows WHERE session_id=? ORDER BY ${identity.id}`,
          )
          .all(sessionId);
        assert.deepEqual(rowMap, [{ rowid: -17, session_id: sessionId }]);
      }
      observations.push({
        observedAt: new Date().toISOString(),
        path: target.path,
        role: target.role,
        agentId: target.agentId,
        userVersion: database.prepare("PRAGMA user_version").get().user_version,
        schema,
        mode,
        freePages: database.prepare("PRAGMA freelist_count").get().freelist_count,
        pageCount: database.prepare("PRAGMA page_count").get().page_count,
        pageSize: database.prepare("PRAGMA page_size").get().page_size,
        fileBytes: fs.statSync(target.path).size,
        walBytes: fs.existsSync(`${target.path}-wal`) ? fs.statSync(`${target.path}-wal`).size : 0,
        values,
        transcript,
        matches,
        rowMap,
        sessions,
        discarded,
        deletedIdsAbsent: [42],
        logicalSha256: createHash("sha256")
          .update(JSON.stringify({ values, transcript, matches, rowMap, sessions, discarded }))
          .digest("hex"),
        searchObservation: target.agentId
          ? "SQLite MATCH saffronquasar, restricted to fixture session"
          : undefined,
        integrity: "ok",
        foreignKeyFailures: [],
      });
    } finally {
      database.close();
    }
  }
  return observations;
}

export function assertPublishedDriverReclaimed(before, after) {
  assert.equal(after.length, before.length);
  for (const [index, database] of after.entries()) {
    const baseline = before[index];
    assert.equal(database.path, baseline.path);
    assert(baseline.freePages > 800, "Legacy fixture omitted deleted pages");
    assert(database.freePages < baseline.freePages, "Update did not reclaim deleted pages");
    assert(
      database.fileBytes + database.walBytes < baseline.fileBytes + baseline.walBytes,
      "Update did not reduce settled database and WAL logical file bytes",
    );
    assert.deepEqual(database.values, baseline.values);
    assert.deepEqual(database.transcript, baseline.transcript);
    assert.deepEqual(database.matches, baseline.matches);
    assert.equal(database.logicalSha256, baseline.logicalSha256);
  }
}
