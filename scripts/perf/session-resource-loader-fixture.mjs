/** Add a large workspace and lazy legacy predicates to an offline team-shape fixture. */
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: {
    root: { type: "string" },
    workspace: { type: "string" },
    "legacy-predicates": { type: "boolean" },
    "canonical-payloads": { type: "boolean" },
    "complete-gib": { type: "string" },
    "pilot-pairs": { type: "string" },
  },
});
assert(values.root);
const root = path.resolve(values.root);
const summaryPath = path.join(root, "team-shape-summary.json");
let summary = fs.existsSync(summaryPath)
  ? JSON.parse(fs.readFileSync(summaryPath, "utf8"))
  : undefined;
assert(values["complete-gib"] || summary?.format === "openclaw-team-shape-v1");
const result = {};
if (values["complete-gib"]) {
  const targetBytes = Number(values["complete-gib"]) * 1024 ** 3;
  const pilotPairs = values["pilot-pairs"] ? Number(values["pilot-pairs"]) : undefined;
  assert(Number.isSafeInteger(targetBytes) && targetBytes > 0);
  assert(pilotPairs === undefined || (Number.isSafeInteger(pilotPairs) && pilotPairs > 0));
  const config = JSON.parse(fs.readFileSync(path.join(root, "openclaw.json"), "utf8"));
  assert(
    config.gateway?.mode === "local" &&
      config.gateway?.bind === "loopback" &&
      config.gateway?.auth?.mode === "none" &&
      config.plugins?.enabled === false &&
      config.cron?.enabled === false &&
      config.agents?.entries?.main?.workspace === path.join(root, "workspace"),
    "Completion only accepts the isolated team-shape fixture configuration",
  );
  // Validate the existing synthetic database before opening any write-capable owner.
  const databasePath = path.join(root, "agents/main/agent/openclaw-agent.sqlite");
  const inspection = new DatabaseSync(databasePath, { readOnly: true });
  let sessions;
  try {
    sessions = inspection
      .prepare(`SELECT session_key, current_session_id AS session_id,
      entry_json, EXISTS(SELECT 1 FROM transcript_events AS event
        WHERE event.session_id = node.current_session_id) AS populated
      FROM session_nodes AS node ORDER BY session_key`)
      .all()
      .map((session) => {
        assert(typeof session.session_id === "string");
        assert(typeof session.session_key === "string");
        assert(typeof session.entry_json === "string");
        return {
          session_id: session.session_id,
          session_key: session.session_key,
          entry_json: session.entry_json,
          populated: Number(session.populated),
        };
      });
    assert.equal(sessions.length, 5000);
    for (const session of sessions) {
      const index = /^team-shape-session-(\d+)$/.exec(session.session_id)?.[1];
      assert(index !== undefined && Number(index) < 5000);
      assert.equal(session.session_key, `agent:main:${session.session_id}`);
      assert.equal(JSON.parse(session.entry_json).displayName, `Team fixture session ${index}`);
    }
    const selected = inspection
      .prepare(`SELECT session_id, count(*) AS events
      FROM transcript_event_identities GROUP BY session_id ORDER BY count(*) DESC LIMIT 1`)
      .get();
    assert(selected);
    summary ??= { format: "openclaw-team-shape-v1", sessionCount: sessions.length };
    assert.equal(summary.format, "openclaw-team-shape-v1");
    summary.completion ??= {
      originalSelectedSession: selected,
      originalPopulatedSessions: sessions.filter((session) => session.populated).length,
      fillerSessionIds: sessions
        .filter((session) => session.session_id !== selected.session_id)
        .map((session) => session.session_id),
      startedAt: new Date().toISOString(),
      completed: false,
      addedToolResultBytes: 0,
      addedToolResultPairs: 0,
    };
    assert(summary.completion.fillerSessionIds.length > 0);
    assert(
      summary.completion.fillerSessionIds.every((id) =>
        sessions.some((session) => session.session_id === id),
      ),
    );
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    inspection.close();
  }
  Object.assign(process.env, {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  });
  const owner = await import("../../src/state/openclaw-agent-db.ts");
  const { appendTranscriptEventsInTransaction } =
    await import("../../src/config/sessions/session-accessor.sqlite-transcript-store.ts");
  const database = owner.openOpenClawAgentDatabase({ agentId: "main" });
  const started = performance.now();
  const bytes = () =>
    database.db.prepare("PRAGMA page_count").get().page_count *
    database.db.prepare("PRAGMA page_size").get().page_size;
  const initialBytes = bytes();
  const fillIds = new Set(summary.completion.fillerSessionIds);
  const fillers = sessions.filter((session) => fillIds.has(session.session_id));
  const timestamp = "2026-01-01T00:00:00.000Z";
  const append = (session, events) =>
    owner.runOpenClawAgentWriteTransaction(
      (writer) =>
        appendTranscriptEventsInTransaction(
          writer,
          { agentId: "main", sessionId: session.session_id, sessionKey: session.session_key },
          events,
        ),
      { agentId: "main" },
    );
  const message = (id, parentId, payload) => ({
    type: "message",
    id,
    parentId,
    timestamp,
    message: { ...payload, timestamp: 1 },
  });
  const pair = (id, parentId, text) => [
    message(`${id}-call`, parentId, {
      role: "assistant",
      content: [
        { type: "toolCall", id, name: "read", arguments: { path: "synthetic-output.txt" } },
      ],
    }),
    message(`${id}-result`, `${id}-call`, {
      role: "toolResult",
      toolCallId: id,
      toolName: "read",
      isError: false,
      content: [{ type: "text", text }],
    }),
  ];
  let pairs = 0;
  const pairLimit = pilotPairs ?? Infinity;
  try {
    for (const [index, session] of fillers.entries()) {
      if (index >= pairLimit) {
        break;
      }
      if (!session.populated) {
        append(session, [
          { type: "session", version: 3, id: session.session_id, timestamp },
          message("completion-request", null, {
            role: "user",
            content: "Read synthetic tool output.",
          }),
          ...pair("completion-initial", "completion-request", "Synthetic output."),
        ]);
      }
      if (index % 100 === 0) {
        console.log(
          JSON.stringify({
            phase: "initialize",
            sessions: index + 1,
            elapsedMs: performance.now() - started,
          }),
        );
        await yieldTurn();
      }
    }
    const leaf = database.db.prepare(
      "SELECT leaf_event_id, indexed_seq FROM session_transcript_index_state WHERE session_id=?",
    );
    const zeroes = Buffer.alloc((3 * 1024 * 1024) / 4);
    while (bytes() < targetBytes && pairs < pairLimit) {
      for (const session of fillers) {
        if (bytes() >= targetBytes || pairs >= pairLimit) {
          break;
        }
        const current = leaf.get(session.session_id);
        let parentId = current?.leaf_event_id;
        assert(typeof parentId === "string");
        const events = [];
        for (let batch = 0; batch < 2 && pairs < pairLimit; batch++) {
          const id = `completion-${Number(current.indexed_seq) + batch * 2 + 1}`;
          const key = createHash("sha256").update(`${session.session_id}:${id}`).digest();
          const cipher = createCipheriv("aes-256-ctr", key, Buffer.alloc(16));
          const text = cipher.update(zeroes).toString("base64");
          cipher.final();
          events.push(...pair(id, parentId, text));
          parentId = `${id}-result`;
          pairs++;
        }
        append(session, events);
        if (pairs % 100 === 0 || pairs === pilotPairs) {
          console.log(
            JSON.stringify({
              phase: "fill",
              pairs,
              databaseBytes: bytes(),
              elapsedMs: performance.now() - started,
            }),
          );
          await yieldTurn();
        }
      }
    }
    database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const populated = database.db
      .prepare("SELECT count(DISTINCT session_id) AS count FROM transcript_events")
      .get().count;
    const indexed = database.db
      .prepare("SELECT count(*) AS count FROM session_transcript_index_state WHERE needs_rebuild=0")
      .get().count;
    const payloadBytes = database.db
      .prepare("SELECT sum(event_utf8_bytes) AS bytes FROM transcript_events")
      .get().bytes;
    const totalPairs = Number(
      database.db
        .prepare(
          "SELECT count(*) AS count FROM transcript_event_identities WHERE event_id GLOB 'completion-[0-9]*-result'",
        )
        .get().count,
    );
    assert.equal(
      database.db
        .prepare("SELECT count(*) AS count FROM transcript_event_identities WHERE session_id=?")
        .get(summary.completion.originalSelectedSession.session_id).count,
      summary.completion.originalSelectedSession.events,
    );
    Object.assign(summary, {
      agentDatabaseBytes: fs.statSync(database.path).size,
      populatedSessionCount: populated,
      indexedSessionCount: indexed,
      transcriptPayloadBytes: payloadBytes,
    });
    Object.assign(summary.completion, {
      completed: populated === 5000 && indexed === 5000 && bytes() >= targetBytes,
      targetBytes,
      addedToolResultBytes: totalPairs * 1024 ** 2,
      addedToolResultPairs: totalPairs,
      lastRun: { initialBytes, finalBytes: bytes(), pairs, elapsedMs: performance.now() - started },
    });
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    result.completion = {
      ...summary.completion.lastRun,
      populated,
      indexed,
      completed: summary.completion.completed,
    };
    assert(pilotPairs !== undefined || summary.completion.completed);
  } finally {
    await owner.closeOpenClawAgentDatabasesAsync();
  }
}
if (values.workspace) {
  const workspace = path.resolve(values.workspace);
  fs.mkdirSync(workspace);
  const body = Buffer.alloc(18000, "synthetic workspace fixture\n");
  for (let directory = 0; directory < 620; directory++) {
    const folder = path.join(workspace, `dir-${directory}`);
    fs.mkdirSync(folder);
    for (let file = 0; file < 100; file++) {
      fs.writeFileSync(path.join(folder, `file-${file}.txt`), body);
    }
  }
  result.workspace = { files: 62000, bytes: 62000 * body.length };
}
assert(!(values["legacy-predicates"] && values["canonical-payloads"]));
if (values["legacy-predicates"] || values["canonical-payloads"]) {
  Object.assign(process.env, {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  });
  const {
    openOpenClawAgentDatabase,
    runOpenClawAgentWriteTransaction,
    closeOpenClawAgentDatabasesAsync,
  } = await import("../../src/state/openclaw-agent-db.ts");
  const {
    readTranscriptPayload,
    prepareTranscriptPayload,
    readTranscriptStorageEncoding,
    TRANSCRIPT_PAYLOAD_COLUMNS,
  } = await import("../../src/config/sessions/transcript-payload.ts");
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  try {
    const selected =
      summary?.completion?.originalSelectedSession ??
      database.db
        .prepare(
          "SELECT session_id, count(*) AS events FROM transcript_event_identities GROUP BY session_id ORDER BY count(*) DESC LIMIT 1",
        )
        .get();
    assert(selected);
    // Reproduce the shipped lazy-predicate state while retaining valid identity/index facts.
    const rows = database.db
      .prepare(
        "SELECT seq,event_json,event_zstd,event_utf8_bytes FROM transcript_events WHERE session_id=?",
      )
      .all(selected.session_id);
    let bytes = 0;
    runOpenClawAgentWriteTransaction(
      (owner) => {
        const columns = TRANSCRIPT_PAYLOAD_COLUMNS.filter(
          (column) => !["session_id", "seq", "created_at"].includes(column),
        );
        const restore = owner.db.prepare(
          `UPDATE transcript_events SET ${columns.map((column) => `${column}=?`).join(",")} WHERE session_id=? AND seq=?`,
        );
        const encoding = readTranscriptStorageEncoding(owner.db);
        const write = owner.db
          .prepare(`UPDATE transcript_events SET event_json=?,event_zstd=NULL,navigation_json=NULL,
    navigation_type=NULL,navigation_custom_type=NULL,navigation_display=0,message_role=NULL,
    navigation_last_type=NULL,navigation_last_custom_type=NULL,navigation_valid=1
    WHERE session_id=? AND seq=?`);
        for (const row of rows) {
          const payload = readTranscriptPayload(row);
          bytes += Buffer.byteLength(payload);
          if (values["canonical-payloads"]) {
            const stored = prepareTranscriptPayload(owner.db, payload, undefined, encoding);
            restore.run(...columns.map((column) => stored[column]), selected.session_id, row.seq);
          } else {
            write.run(payload, selected.session_id, row.seq);
          }
        }
      },
      { agentId: "main" },
    );
    result[values["canonical-payloads"] ? "canonical" : "legacy"] = { ...selected, bytes };
  } finally {
    await closeOpenClawAgentDatabasesAsync();
  }
}
console.log(JSON.stringify(result));
