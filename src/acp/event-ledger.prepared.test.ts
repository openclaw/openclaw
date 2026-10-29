import path from "node:path";
import { constants } from "node:sqlite";
import { afterEach, describe, expect, it as baseIt } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
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
function seedSession(
  db: ReturnType<typeof nativeDatabase>,
  id: string,
  key: string,
  cwd: string,
  payloads: string[],
  gap = 1,
  understated = false,
) {
  const events = payloads.map((json, index) => {
    const bytes = Buffer.byteLength(id) + Buffer.byteLength(key) + Buffer.byteLength(json) + 32;
    return { seq: (index + 1) * gap, json, bytes };
  });
  const bytes = Buffer.byteLength(id + key + cwd) + 32 + events.reduce((n, e) => n + e.bytes, 0);
  db.prepare(
    "INSERT INTO acp_replay_sessions (session_id, session_key, cwd, complete, created_at, updated_at, next_seq, estimated_bytes) VALUES (?, ?, ?, 1, 100, 100, ?, ?)",
  ).run(id, key, cwd, (events.at(-1)?.seq ?? 0) + 1, understated ? 1 : bytes);
  const insert = db.prepare(
    "INSERT INTO acp_replay_events (session_id, seq, at, session_key, run_id, update_json, estimated_bytes) VALUES (?, ?, 100, ?, NULL, ?, ?)",
  );
  for (const event of events) {
    insert.run(id, event.seq, key, event.json, event.bytes);
  }
}
function workerFixture(options: { path: string }) {
  const database = openOpenClawStateDatabase(options);
  const context: WorkerWriteOperationContext = {
    open: () => database,
    stateOptions: () => ({ path: options.path, env: process.env }),
    write: (operation) => runOpenClawStateWriteTransaction(operation, options),
    writeAdmitted: (operation) => runOpenClawStateWriteTransaction(operation, options),
  };
  return { db: requireNativeSqliteDatabase(database.db), context };
}
async function fixture(
  dir: string,
  { warm = 0 }: { warm?: number } = {},
  session = defaultSession,
) {
  const options = { path: path.join(dir, "state.sqlite") };
  const ledger = createSqliteAcpEventLedger(options);
  const record = (text: string, runId?: string) =>
    ledger.recordUpdate({ ...session, runId, update: update(text) });
  await ledger.startSession(session);
  for (let index = 0; index < warm; index++) {
    await record(`warm-${index}`);
  }
  return { options, ledger, session, record, db: () => nativeDatabase(options) };
}

describe("ACP replay worker", () => {
  afterEach(() => closeOpenClawStateDatabaseAsync());

  it("appends without reading earlier payload columns", async ({ dir }) => {
    const { options, session, record } = await fixture(dir);
    await record("prior payload");
    await closeOpenClawStateDatabaseAsync();
    const { db, context } = workerFixture(options);
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

  it("rolls back failed appends and preserves sequence, timestamps and bytes across reopen", async ({
    dir,
  }) => {
    const f = await fixture(dir, { warm: 3 });
    const large = "漢".repeat(32 * 1024);
    await f.record(large);
    await f.record("small after large", "run-漢😀");
    const db = f.db();
    const initial = db.prepare("SELECT created_at, updated_at FROM acp_replay_sessions").get();
    db.exec(`CREATE TRIGGER reject_replay_event BEFORE INSERT ON acp_replay_events
        BEGIN SELECT RAISE(ABORT, 'replay event rejected'); END`);
    try {
      await expect(f.record("refused")).rejects.toThrow(/replay event rejected/);
    } finally {
      db.exec("DROP TRIGGER reject_replay_event");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
    const before = Date.now();
    await f.record("accepted");
    const after = Date.now();
    const replay = await f.ledger.readReplayBySessionId(f.session);
    expect(replay.events.slice(3).map((event) => [event.seq, event.runId, event.update])).toEqual([
      [4, undefined, update(large)],
      [5, "run-漢😀", update("small after large")],
      [6, undefined, update("accepted")],
    ]);
    const last = replay.events.at(-1);
    expect(before).toBeGreaterThan(Number(initial?.updated_at));
    expect(last?.at).toBeGreaterThanOrEqual(before);
    expect(last?.at).toBeLessThanOrEqual(after);
    expectValues(db, "created_at, updated_at, next_seq FROM acp_replay_sessions").toEqual([
      initial?.created_at,
      last?.at,
      7,
    ]);
    expectAcpReplayUtf8Accounting(db);
    await closeOpenClawStateDatabaseAsync();
    await f.record("after reopen");
    const reopened = await f.ledger.readReplayBySessionId(f.session);
    expect(reopened.events.at(-1)).toMatchObject({ seq: 7, update: update("after reopen") });
    expectAcpReplayUtf8Accounting(f.db());
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
      JSON.stringify({
        sessionUpdate: "user_message_chunk",
        messageId: "user:run",
        content: content("tail"),
      }),
    ]);
    await expect(ledger.readReplayBySessionId(session)).resolves.toEqual({
      complete: false,
      events: [],
    });
    expectAcpReplayUtf8Accounting(db);
  });

  it.for([false, true])(
    "carries byte-budget accounting across ordered partial-session eviction (understated=%s)",
    async (understated, { dir }) => {
      const options = { path: path.join(dir, "state.sqlite") };
      const { db, context } = workerFixture(options);
      const payloads = Array<string>(130).fill(JSON.stringify(update("x".repeat(64 * 1024))));
      runOpenClawStateWriteTransaction(() => {
        for (const id of ["a", "b", "c"]) {
          seedSession(db, id, id, "", payloads, 1, understated && id === "a");
        }
      }, options);
      const measured = trackSqliteStatementExecutions(db, ["budgetRead"], (sql) =>
        /^select /i.test(sql) &&
        /from "acp_replay_sessions"/i.test(sql) &&
        (/sum\(/i.test(sql) || /order by "updated_at" asc/i.test(sql))
          ? "budgetRead"
          : null,
      );
      try {
        acpReplayOperations["acpReplay.start"](
          { session: { ...defaultSession, sessionId: "fresh" }, now: 200 },
          context,
        );
      } finally {
        measured.restore();
      }
      expectValues(db, "session_id, complete FROM acp_replay_sessions ORDER BY session_id").toEqual(
        ["b", 0, "c", 1, "fresh", 1],
      );
      expectValues(
        db,
        "MIN(seq), MAX(seq), COUNT(*) FROM acp_replay_events WHERE session_id = 'b'",
      ).toEqual([65, 130, 66]);
      expectValues(db, "COUNT(*) FROM acp_replay_events WHERE session_id = 'c'").toEqual([130]);
      expect(expectAcpReplayUtf8Accounting(db)).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(measured.counts.budgetRead).toBeLessThanOrEqual(2);
    },
  );

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
      for (const sessionId of sessionIds) {
        const payloads = Array.from(
          { length: sessionId === "a" || sessionId === "b" ? 5_001 : 0 },
          (_, index) => JSON.stringify(update(sessionId + "-" + index)),
        );
        seedSession(db, sessionId, "key-" + sessionId, "/work", payloads, 10);
      }
    }, options);
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
