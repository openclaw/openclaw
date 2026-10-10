import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  readSqliteTranscriptPayload,
  sqliteTranscriptPayloadColumns,
} from "../../../lib/sqlite-transcript-payload.mjs";
import { readDatabase } from "./observations.mjs";

const retained = "published update keeps π \0 雪";
const event = JSON.stringify({
  type: "message",
  id: "reclamation-kept",
  message: { role: "assistant", content: [{ type: "text", text: "saffronquasar 雪" }] },
});
const sessionId = "published-driver-reclamation";
const bootstrapSessionId = "published-driver-bootstrap";
const bootstrapHeader = {
  type: "session",
  id: bootstrapSessionId,
  version: 3,
  timestamp: "2026-09-01T00:00:00.000Z",
  cwd: "/home/appuser",
};
const reclamationHeader = JSON.stringify({ ...bootstrapHeader, id: sessionId });

// Gateway reconcile may reallocate derived FTS row IDs. Compare searchable
// content across maintenance and verify FTS/row-map identity at each observation.
function searchContent(matches) {
  return matches?.map(({ text, session_id, message_id }) => ({ text, session_id, message_id }));
}

function rowMapIdentity(database) {
  const columns = database
    .prepare("PRAGMA table_info(session_transcript_fts_rows)")
    .all()
    .map((row) => Object.assign({}, row));
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

/** Let the published Doctor create its own schema by importing real legacy input. */
export function seedPublishedDriverSessionSources(state) {
  assert.equal(state, "/home/appuser/.openclaw");
  for (const { agentId } of publishedDriverSqliteTargets(state)) {
    if (!agentId) {
      continue;
    }
    const directory = path.join(state, "agents", agentId, "sessions");
    const sessionFile = path.join(directory, `${bootstrapSessionId}.jsonl`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "sessions.json"),
      `${JSON.stringify({
        [`agent:${agentId}:bootstrap`]: {
          sessionId: bootstrapSessionId,
          sessionFile,
          updatedAt: Date.now(),
        },
      })}\n`,
      { flag: "wx" },
    );
    fs.writeFileSync(sessionFile, `${JSON.stringify(bootstrapHeader)}\n`, { flag: "wx" });
  }
}

function readTranscript(database, id) {
  const rows = database
    .prepare(`SELECT rowid,seq,${sqliteTranscriptPayloadColumns(database)}
      FROM transcript_events WHERE session_id=? ORDER BY seq,rowid`)
    .all(id);
  return rows.map((row) => ({
    rowid: row.rowid,
    seq: row.seq,
    event: readSqliteTranscriptPayload(row),
  }));
}

function inspectImportedSession(database, agentId) {
  const entry = database
    .prepare("SELECT current_session_id FROM session_nodes WHERE session_key=?")
    .get(`agent:${agentId}:bootstrap`);
  assert.equal(
    entry?.current_session_id,
    bootstrapSessionId,
    "Published Doctor did not import the session",
  );
  const transcript = readTranscript(database, bootstrapSessionId);
  assert.equal(transcript.length, 1, "Published Doctor did not import the transcript");
  assert.deepEqual(JSON.parse(transcript[0].event), bootstrapHeader);
  return { sessionId: entry.current_session_id, transcript };
}

/** The fixture calls this before installing or starting the baseline service. */
export function seedPublishedDriverLegacySqlite(state) {
  assert.equal(state, "/home/appuser/.openclaw");
  const seededAt = Date.now();
  for (const target of publishedDriverSqliteTargets(state)) {
    assert(fs.statSync(target.path).isFile(), `Doctor did not prepare ${target.path}`);
    const database = new DatabaseSync(target.path);
    try {
      if (target.agentId) {
        inspectImportedSession(database, target.agentId);
      }
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
          VALUES(40,?,0,?,?)`)
          .run(sessionId, reclamationHeader, seededAt);
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
  return publishedDriverSqliteTargets(state).map((target) =>
    readDatabase(target.path, (database) => {
      const mode = database.prepare("PRAGMA auto_vacuum").get().auto_vacuum;
      assert.equal(mode, expectedMode, `${target.path} reclamation mode`);
      assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
      const values = database
        .prepare(
          "SELECT id,value,hex(CAST(value AS BLOB)) AS bytes FROM published_driver_retained ORDER BY id",
        )
        .all()
        .map((row) => Object.assign({}, row));
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
      let indexedRows;
      let rowMap;
      let schema;
      let sessions;
      let importedSession;
      if (target.agentId) {
        importedSession = inspectImportedSession(database, target.agentId);
        const identity = rowMapIdentity(database);
        schema = {
          transcriptColumns: database
            .prepare("PRAGMA table_info(transcript_events)")
            .all()
            .map((row) => Object.assign({}, row)),
          rowMapColumns: identity.columns,
        };
        sessions = database
          .prepare(`SELECT node.session_key,node.current_session_id,window.session_id
          FROM session_nodes AS node JOIN session_windows AS window
          ON window.session_id=node.current_session_id AND window.session_key=node.session_key
          WHERE node.session_key=? ORDER BY node.session_key`)
          .all(`agent:${target.agentId}:reclamation`)
          .map((row) => Object.assign({}, row));
        assert.deepEqual(sessions, [
          {
            session_key: `agent:${target.agentId}:reclamation`,
            current_session_id: sessionId,
            session_id: sessionId,
          },
        ]);
        transcript = readTranscript(database, sessionId);
        assert.deepEqual(transcript, [
          { rowid: 40, seq: 0, event: reclamationHeader },
          { rowid: 41, seq: 7, event },
        ]);
        matches = database
          .prepare(`SELECT rowid,text,session_id,message_id FROM session_transcript_fts
          WHERE session_transcript_fts MATCH 'saffronquasar' AND session_id=? ORDER BY rowid`)
          .all(sessionId)
          .map((row) => Object.assign({}, row));
        assert.deepEqual(searchContent(matches), [
          {
            text: "saffronquasar 雪",
            session_id: sessionId,
            message_id: "reclamation-kept",
          },
        ]);
        indexedRows = database
          .prepare(`SELECT rowid,text,session_id,message_id FROM session_transcript_fts
          WHERE session_id=? ORDER BY rowid`)
          .all(sessionId)
          .map((row) => Object.assign({}, row));
        assert.deepEqual(indexedRows, matches, "Transcript FTS contains unexpected rows");
        rowMap = database
          .prepare(
            `SELECT ${identity.id} AS rowid,session_id${identity.current ? ",message_id" : ""}
          FROM session_transcript_fts_rows WHERE session_id=? ORDER BY ${identity.id}`,
          )
          .all(sessionId)
          .map((row) => Object.assign({}, row));
        assert.deepEqual(
          rowMap,
          indexedRows.map(({ rowid, session_id, message_id }) =>
            identity.current ? { rowid, session_id, message_id } : { rowid, session_id },
          ),
          "Transcript FTS rows and row-map identities differ",
        );
      }
      return {
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
        indexedRows,
        rowMap,
        sessions,
        importedSession,
        discarded,
        deletedIdsAbsent: [42],
        logicalSha256: createHash("sha256")
          .update(
            JSON.stringify({
              values,
              transcript,
              matches: searchContent(matches),
              sessions,
              importedSession,
              discarded,
            }),
          )
          .digest("hex"),
        searchObservation: target.agentId
          ? "SQLite MATCH saffronquasar, restricted to fixture session"
          : undefined,
        integrity: "ok",
        foreignKeyFailures: [],
      };
    }),
  );
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
    assert.deepEqual(searchContent(database.matches), searchContent(baseline.matches));
    assert.equal(database.logicalSha256, baseline.logicalSha256);
  }
}
