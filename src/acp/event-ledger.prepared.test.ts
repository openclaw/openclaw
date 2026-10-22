import path from "node:path";
import { constants } from "node:sqlite";
import { afterEach, describe, expect, it as baseIt } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import type { WorkerWriteOperationContext } from "../state/worker-operation-registry.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { createSqliteAcpEventLedger } from "./event-ledger.js";
import { expectAcpReplayUtf8Accounting } from "./event-ledger.test-support.js";
import { acpReplayOperations } from "./event-ledger.worker.js";

const it = baseIt.extend<{ dir: string }>({
  dir: async ({ task }, use) => withTestDir({ prefix: `openclaw-acp-${task.id}-` }, use),
});

const content = (text: string) => ({ type: "text" as const, text });
const update = (text: string) => ({
  sessionUpdate: "agent_message_chunk" as const,
  content: content(text),
});
const defaultSession = { sessionId: "session", sessionKey: "key", cwd: "/work", complete: true };
const nativeDatabase = (options: { path: string }) =>
  requireNativeSqliteDatabase(openOpenClawStateDatabase(options).db);
const expectValues = (db: ReturnType<typeof nativeDatabase>, query: string) =>
  expect(db.prepare(`SELECT ${query}`).all().flatMap(Object.values));
async function fixture(
  dir: string,
  { warm = 0 }: { warm?: number } = {},
  session = defaultSession,
) {
  const options = { path: path.join(dir, "state.sqlite") };
  const ledger = createSqliteAcpEventLedger(options);
  const record = (text: string) => ledger.recordUpdate({ ...session, update: update(text) });
  await ledger.startSession(session);
  for (let index = 0; index < warm; index++) {
    await record(`warm-${index}`);
  }
  return { options, ledger, session, record, db: () => nativeDatabase(options) };
}

describe("ACP replay worker", () => {
  afterEach(() => closeOpenClawStateDatabaseAsync());

  it("binds fresh metadata, sequence and payload values across worker appends", async ({ dir }) => {
    const f = await fixture(dir, { warm: 3 });
    const { ledger, session } = f;
    const db = f.db();
    const appends = Array.from({ length: 4 }, (_, index) => ({
      sessionKey: `key-${index}-漢😀`,
      runId: index % 2 ? `run-${index}` : undefined,
      update: update(`payload-${index}-漢\0\ud800`),
    }));
    const expected = structuredClone(appends);
    const initial = db.prepare("SELECT created_at, updated_at FROM acp_replay_sessions").get();
    // Separate native clock windows without changing worker-issued authority time.
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
    const timestampWindows: Array<{ before: number; after: number }> = [];
    for (const event of appends) {
      const before = Date.now();
      await ledger.recordUpdate({ sessionId: session.sessionId, ...event });
      timestampWindows.push({ before, after: Date.now() });
    }
    const replay = await ledger.readReplayBySessionId(session);
    expect(replay).toMatchObject({ complete: true, sessionKey: "key-3-漢😀" });
    expectValues(db, "created_at, updated_at, next_seq FROM acp_replay_sessions").toEqual([
      initial?.created_at,
      replay.events.at(-1)?.at,
      8,
    ]);
    expect(
      replay.events
        .slice(3)
        .map((event) => [event.seq, event.sessionKey, event.runId, event.update]),
    ).toEqual(
      expected.map((event, index) => [index + 4, event.sessionKey, event.runId, event.update]),
    );
    expect(timestampWindows[0]?.before).toBeGreaterThan(Number(initial?.updated_at));
    for (const [index, { before, after }] of timestampWindows.entries()) {
      expect(replay.events[index + 3]?.at).toBeGreaterThanOrEqual(before);
      expect(replay.events[index + 3]?.at).toBeLessThanOrEqual(after);
    }
    expectAcpReplayUtf8Accounting(db);

    await closeOpenClawStateDatabaseAsync();
    await f.record("after reopen");
    const reopened = await ledger.readReplayBySessionId(session);
    expect(reopened.events.at(-1)).toMatchObject({ seq: 8, update: update("after reopen") });
    expectAcpReplayUtf8Accounting(f.db());
  });

  it("appends without reading earlier payload columns", async ({ dir }) => {
    const { options, session, record } = await fixture(dir);
    await record("prior payload");
    await closeOpenClawStateDatabaseAsync();
    const database = openOpenClawStateDatabase(options);
    const db = requireNativeSqliteDatabase(database.db);
    const context: WorkerWriteOperationContext = {
      open: () => database,
      stateOptions: () => ({ path: options.path, env: process.env }),
      write: (operation) => runOpenClawStateWriteTransaction(operation, options),
      writeAdmitted: (operation) => runOpenClawStateWriteTransaction(operation, options),
    };
    db.setAuthorizer((action, table, column) =>
      action === constants.SQLITE_READ && table === "acp_replay_events" && column === "update_json"
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK,
    );
    try {
      acpReplayOperations["acpReplay.append"](
        { session, events: [{ update: update("next payload"), createdAt: 10, at: 11 }] },
        context,
      );
    } finally {
      db.setAuthorizer(null);
    }
    expectValues(db, "COUNT(*) FROM acp_replay_events").toEqual([2]);
    expectAcpReplayUtf8Accounting(db);
  });

  it("rolls back sequence and byte accounting when an event insert fails", async ({ dir }) => {
    const f = await fixture(dir, { warm: 3 });
    const large = "漢".repeat(32 * 1024);
    await f.record(large);
    await f.record("small after large");
    const db = f.db();
    db.exec(`CREATE TRIGGER reject_replay_event BEFORE INSERT ON acp_replay_events
        BEGIN SELECT RAISE(ABORT, 'replay event rejected'); END`);
    try {
      await expect(f.record("refused")).rejects.toThrow(/replay event rejected/);
    } finally {
      db.exec("DROP TRIGGER reject_replay_event");
    }
    await f.record("accepted");
    const replay = await f.ledger.readReplayBySessionId(f.session);
    expect(replay.events.slice(3).map((event) => [event.seq, event.update])).toEqual([
      [4, update(large)],
      [5, update("small after large")],
      [6, update("accepted")],
    ]);
    expectAcpReplayUtf8Accounting(db);
  });

  it("retains a later prompt block after byte-budget exhaustion", async ({ dir }) => {
    const session = { sessionId: "s", sessionKey: "k", cwd: "", complete: true };
    const { ledger, db: getDb } = await fixture(dir, {}, session);
    await ledger.recordUserPrompt({
      ...session,
      runId: "run",
      prompt: [content("漢".repeat(Math.ceil((16 * 1024 * 1024) / 3))), content("tail")],
    });
    const db = getDb();
    expectValues(db, "seq, update_json FROM acp_replay_events").toEqual([
      2,
      JSON.stringify({ sessionUpdate: "user_message_chunk", content: content("tail") }),
    ]);
    await expect(ledger.readReplayBySessionId(session)).resolves.toEqual({
      complete: false,
      events: [],
    });
    expectAcpReplayUtf8Accounting(db);
  });

  it("uses fixed caps across shared handles and gapped sequences", async ({ dir }) => {
    const options = { path: path.join(dir, "state.sqlite") };
    const first = createSqliteAcpEventLedger(options);
    const second = createSqliteAcpEventLedger(options);
    const db = nativeDatabase(options);
    const sessionIds = [
      "a",
      "b",
      ...Array.from({ length: 199 }, (_, index) => "c" + String(index).padStart(3, "0")),
    ];
    // Seed actual retained rows in one transaction, not thousands of worker round trips.
    runOpenClawStateWriteTransaction(() => {
      const insertSession = db.prepare(
        "INSERT INTO acp_replay_sessions (session_id, session_key, cwd, complete, created_at, updated_at, next_seq, estimated_bytes) VALUES (?, ?, '/work', 1, 100, 100, ?, ?)",
      );
      const insertEvent = db.prepare(
        "INSERT INTO acp_replay_events (session_id, seq, at, session_key, run_id, update_json, estimated_bytes) VALUES (?, ?, 100, ?, NULL, ?, ?)",
      );
      for (const sessionId of sessionIds) {
        const sessionKey = "key-" + sessionId;
        const events = Array.from(
          { length: sessionId === "a" || sessionId === "b" ? 5_001 : 0 },
          (_, index) => {
            const updateJson = JSON.stringify(update(sessionId + "-" + index));
            const bytes =
              Buffer.byteLength(sessionId) +
              Buffer.byteLength(sessionKey) +
              Buffer.byteLength(updateJson) +
              32;
            return { seq: (index + 1) * 10, updateJson, bytes };
          },
        );
        const bytes =
          Buffer.byteLength(sessionId) +
          Buffer.byteLength(sessionKey) +
          Buffer.byteLength("/work") +
          32 +
          events.reduce((sum, event) => sum + event.bytes, 0);
        insertSession.run(sessionId, sessionKey, events.length ? 50_011 : 1, bytes);
        for (const event of events) {
          insertEvent.run(sessionId, event.seq, sessionKey, event.updateJson, event.bytes);
        }
      }
    }, options);
    expectValues(db, "COUNT(*) FROM acp_replay_sessions").toEqual([201]);
    expectValues(db, "COUNT(*) FROM acp_replay_events").toEqual([10_002]);
    expectAcpReplayUtf8Accounting(db);
    // Tied timestamps and gapped sequences must not turn next_seq into an event count.
    await second.startSession({
      sessionId: "a",
      sessionKey: "key-a",
      cwd: "/narrow",
      complete: true,
    });
    expectValues(db, "session_id FROM acp_replay_sessions ORDER BY session_id").toEqual(
      sessionIds.slice(0, -1),
    );
    const retainedEvents = ["a", "b"].flatMap((sessionId) =>
      Array.from({ length: 5_000 }, (_, index) => [sessionId, (index + 2) * 10]).flat(),
    );
    expectValues(db, "session_id, seq FROM acp_replay_events ORDER BY session_id, seq").toEqual(
      retainedEvents,
    );
    expectAcpReplayUtf8Accounting(db);
    await first.recordUpdate({ sessionId: "b", sessionKey: "key-b", update: update("new") });
    expectValues(db, "seq FROM acp_replay_events WHERE session_id = 'b' ORDER BY seq").toEqual([
      ...Array.from({ length: 4_999 }, (_, index) => (index + 3) * 10),
      50_011,
    ]);
    await expect(first.readReplayBySessionId({ sessionId: "b" })).resolves.toEqual({
      complete: false,
      events: [],
    });
    expectAcpReplayUtf8Accounting(db);
  });
});
