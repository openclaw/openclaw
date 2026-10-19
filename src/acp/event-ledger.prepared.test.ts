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
import { normalizeAcpLedgerOptions, type AcpLedgerOptions } from "./event-ledger.types.js";
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
  settings: AcpLedgerOptions & { warm?: number } = {},
  session = defaultSession,
) {
  const { warm = 0, ...limits } = settings;
  const options = { path: path.join(dir, "state.sqlite"), ...limits };
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
    let now = 100;
    const f = await fixture(dir, { now: () => now++, warm: 3 });
    const { ledger, session } = f;
    const db = f.db();
    const appends = Array.from({ length: 4 }, (_, index) => ({
      sessionKey: `key-${index}-漢😀`,
      runId: index % 2 ? `run-${index}` : undefined,
      update: update(`payload-${index}-漢\0\ud800`),
    }));
    const expected = structuredClone(appends);
    for (const event of appends) {
      await ledger.recordUpdate({ sessionId: session.sessionId, ...event });
    }
    const replay = await ledger.readReplayBySessionId(session);
    expect(replay).toMatchObject({ complete: true, sessionKey: "key-3-漢😀" });
    expectValues(db, "updated_at, next_seq FROM acp_replay_sessions").toEqual([114, 8]);
    expect(
      replay.events
        .slice(3)
        .map((event) => [event.seq, event.sessionKey, event.runId, event.update]),
    ).toEqual(
      expected.map((event, index) => [index + 4, event.sessionKey, event.runId, event.update]),
    );
    expect(replay.events.slice(3).map((event) => event.at)).toEqual([108, 110, 112, 114]);
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
    const { now: _now, ...limits } = normalizeAcpLedgerOptions();
    db.setAuthorizer((action, table, column) =>
      action === constants.SQLITE_READ && table === "acp_replay_events" && column === "update_json"
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK,
    );
    try {
      acpReplayOperations["acpReplay.append"](
        { session, limits, events: [{ update: update("next payload"), createdAt: 10, at: 11 }] },
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
    const { ledger, db: getDb } = await fixture(dir, { maxSerializedBytes: 1024 }, session);
    await ledger.recordUserPrompt({
      ...session,
      runId: "run",
      prompt: [content("漢".repeat(400)), content("tail")],
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

  it("uses current caps across shared handles and gapped sequences", async ({ dir }) => {
    const options = { path: path.join(dir, "state.sqlite"), now: () => 100 };
    const cappedLedger = (maxEventsPerSession: number, maxSessions: number) =>
      createSqliteAcpEventLedger({ ...options, maxEventsPerSession, maxSessions });
    const roomy = cappedLedger(10, 3);
    const narrow = cappedLedger(2, 2);
    for (const sessionId of ["a", "b", "c"]) {
      const session = { sessionId, sessionKey: `key-${sessionId}`, cwd: "/work", complete: true };
      await roomy.startSession(session);
      for (let index = 0; index < 3; index++) {
        await roomy.recordUpdate({ ...session, update: update(`${sessionId}-${index}`) });
      }
    }
    const db = nativeDatabase(options);
    // Imported/retained history can have gaps; next_seq is not an event count.
    db.exec(
      "UPDATE acp_replay_events SET seq = seq * 10; UPDATE acp_replay_sessions SET next_seq = 31",
    );
    await narrow.startSession({
      sessionId: "a",
      sessionKey: "key-a",
      cwd: "/narrow",
      complete: true,
    });
    expectValues(db, "session_id FROM acp_replay_sessions ORDER BY session_id").toEqual(["a", "b"]);
    const retainedEvents = ["a", 20, "a", 30, "b", 20, "b", 30];
    expectValues(db, "session_id, seq FROM acp_replay_events ORDER BY session_id, seq").toEqual(
      retainedEvents,
    );
    expectAcpReplayUtf8Accounting(db);
    await roomy.recordUpdate({ sessionId: "b", sessionKey: "key-b", update: update("new") });
    expectValues(db, "seq FROM acp_replay_events WHERE session_id = 'b' ORDER BY seq").toEqual([
      20, 30, 31,
    ]);
    await expect(roomy.readReplayBySessionId({ sessionId: "b" })).resolves.toEqual({
      complete: false,
      events: [],
    });
    expectAcpReplayUtf8Accounting(db);
  });
});
