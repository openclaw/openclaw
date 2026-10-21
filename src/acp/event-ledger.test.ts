import { describe, expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { createSqliteAcpEventLedger } from "./event-ledger.js";
import {
  createTestAcpEventLedger,
  expectAcpReplayUtf8Accounting,
  withTestAcpEventLedgerDatabase,
} from "./event-ledger.test-support.js";

const textUpdate = (text: string) => ({
  sessionUpdate: "agent_message_chunk" as const,
  content: { type: "text" as const, text },
});
const makeSession = (sessionId: string, sessionKey: string, cwd = "/work", complete = true) => ({
  sessionId,
  sessionKey,
  cwd,
  complete,
});
const incomplete = { complete: false, events: [] };

describe("ACP event ledger", () => {
  it("persists replay through metadata changes and rejected replay bindings", async () => {
    await withTestAcpEventLedgerDatabase(async ({ databasePath }) => {
      const first = createSqliteAcpEventLedger({ path: databasePath });
      const original = makeSession("session-1", "agent:main:work");
      const thought = { ...textUpdate("Thinking"), sessionUpdate: "agent_thought_chunk" as const };
      const answer = textUpdate("Answer");
      await first.startSession(original);
      await first.recordUpdate({ ...original, runId: "run-1", update: thought });
      await expect(first.readReplay(original)).resolves.toMatchObject({ complete: true });

      const session = makeSession("session-1", "agent:main:canonical-work", "/new-work", false);
      await first.recordUpdate({ ...session, runId: "run-1", update: answer });
      await first.startSession(session);
      await expect(first.readReplay(original)).resolves.toEqual(incomplete);
      await first.markIncomplete(session);
      await expect(first.readReplay(session)).resolves.toEqual(incomplete);
      await expect(first.readReplayBySessionId(session)).resolves.toEqual(incomplete);
      await first.startSession({ ...session, complete: true });

      await closeOpenClawStateDatabaseAsync();
      const second = createSqliteAcpEventLedger({ path: databasePath });
      const replay = await second.readReplay(session);

      expect(replay.complete).toBe(true);
      expect(replay.events.map((event) => [event.seq, event.sessionKey])).toEqual([
        [1, "agent:main:work"],
        [2, "agent:main:canonical-work"],
      ]);
      expect(replay.events.map((event) => event.update)).toEqual([thought, answer]);
    });
  });

  it("serializes appends from separate ledger handles and exposes each committed replay", async () => {
    await withTestAcpEventLedgerDatabase(async ({ databasePath }) => {
      const first = createSqliteAcpEventLedger({ path: databasePath });
      const second = createSqliteAcpEventLedger({ path: databasePath });
      const session = { sessionId: "shared", sessionKey: "key", cwd: "/work", complete: true };
      await first.startSession(session);
      const observed = observeHostDataSql();
      try {
        await Promise.all(
          [first, second].map((ledger, index) =>
            ledger.recordUpdate({
              ...session,
              update: textUpdate(`event-${index}`),
            }),
          ),
        );
        const replay = await second.readReplay(session);
        expect(replay.events.map((event) => event.seq)).toEqual([1, 2]);
        expect(replay.events.map((event) => event.update)).toEqual(
          expect.arrayContaining([0, 1].map((index) => textUpdate(`event-${index}`))),
        );
        await second.markIncomplete(session);
        await expect(first.readReplay(session)).resolves.toEqual(incomplete);
        expect(observed.queries).toEqual([]);
      } finally {
        observed.restore();
      }
    });
  });

  it.each(["UTF-8", "UTF-16le"])(
    "counts UTF-8 fields through metadata changes and resets in %s databases",
    async (encoding) => {
      await withTestAcpEventLedgerDatabase(async ({ databasePath }) => {
        const { DatabaseSync } = requireNodeSqlite();
        const seed = new DatabaseSync(databasePath);
        seed.exec(
          `PRAGMA encoding = '${encoding}'; CREATE TABLE encoding_seed (id INTEGER); DROP TABLE encoding_seed;`,
        );
        seed.close();
        const ledger = createSqliteAcpEventLedger({ path: databasePath });
        const session = makeSession("session-漢\0\ud800", "\udc00-key😀", "/é/e\u0301/台\0😀");
        const db = requireNativeSqliteDatabase(
          openOpenClawStateDatabase({ path: databasePath }).db,
        );
        await ledger.startSession(session);
        const initial = expectAcpReplayUtf8Accounting(db);
        for (let count = 0; count < 10; count++) {
          await ledger.startSession(session);
          expect(expectAcpReplayUtf8Accounting(db)).toBe(initial);
        }
        for (const runId of [undefined, "run-😀\0\ud800"]) {
          await ledger.recordUpdate({
            ...session,
            runId,
            update: textUpdate("漢😀\0\ud800é e\u0301"),
          });
          expectAcpReplayUtf8Accounting(db);
        }
        await ledger.startSession({ ...session, sessionKey: "new-台😀", cwd: "/new-😀\0" });
        expectAcpReplayUtf8Accounting(db);
        expect(db.prepare("SELECT COUNT(*) AS count FROM acp_replay_events").get()?.count).toBe(2);
        await ledger.startSession({ ...session, reset: true });
        expect(expectAcpReplayUtf8Accounting(db)).toBe(initial);
        expect(db.prepare("SELECT COUNT(*) AS count FROM acp_replay_events").get()?.count).toBe(0);
      });
    },
  );

  it("preserves prompt history when a provisional ACP key becomes a canonical Gateway key", async () => {
    const ledger = createTestAcpEventLedger();
    const session = makeSession("acp-session-1", "acp:gateway-session-1");
    const canonical = { ...session, sessionKey: "agent:main:acp:gateway-session-1" };
    await ledger.startSession(session);
    await ledger.recordUserPrompt({
      ...session,
      runId: "run-1",
      prompt: [{ type: "text", text: "Question" }],
    });
    await ledger.recordUpdate({ ...canonical, runId: "run-1", update: textUpdate("Answer") });
    const replay = await ledger.readReplayBySessionKey(canonical);

    expect(replay).toMatchObject({
      complete: true,
      sessionId: session.sessionId,
      sessionKey: canonical.sessionKey,
    });
    expect(replay.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(replay.events.map((event) => event.runId)).toEqual(["run-1", "run-1"]);
    expect(replay.events.map((event) => event.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_message_chunk",
    ]);
  });
});
