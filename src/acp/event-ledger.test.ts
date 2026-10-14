/** Tests ACP event ledger recording, replay, retention, and SQLite persistence. */
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

describe("ACP event ledger", () => {
  it("persists replay through metadata changes and rejected replay bindings", async () => {
    await withTestAcpEventLedgerDatabase(async ({ databasePath }) => {
      const first = createSqliteAcpEventLedger({ path: databasePath, now: () => 1000 });
      await first.startSession({
        sessionId: "session-1",
        sessionKey: "agent:main:work",
        cwd: "/work",
        complete: true,
      });
      await first.recordUpdate({
        sessionId: "session-1",
        sessionKey: "agent:main:work",
        runId: "run-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Thinking" },
        },
      });
      await expect(
        first.readReplay({ sessionId: "session-1", sessionKey: "agent:main:work" }),
      ).resolves.toMatchObject({ complete: true });

      const session = {
        sessionId: "session-1",
        sessionKey: "agent:main:canonical-work",
        cwd: "/new-work",
        complete: false,
      };
      await first.recordUpdate({
        ...session,
        runId: "run-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Answer" },
        },
      });
      await first.startSession(session);
      await expect(
        first.readReplay({ ...session, sessionKey: "agent:main:work" }),
      ).resolves.toEqual({ complete: false, events: [] });
      await first.markIncomplete(session);
      await expect(first.readReplay(session)).resolves.toEqual({ complete: false, events: [] });
      await expect(first.readReplayBySessionId(session)).resolves.toEqual({
        complete: false,
        events: [],
      });
      await first.startSession({ ...session, complete: true });

      await closeOpenClawStateDatabaseAsync();
      const second = createSqliteAcpEventLedger({ path: databasePath });
      const replay = await second.readReplay(session);

      expect(replay.complete).toBe(true);
      expect(replay.events.map((event) => [event.seq, event.sessionKey])).toEqual([
        [1, "agent:main:work"],
        [2, "agent:main:canonical-work"],
      ]);
      expect(replay.events[0]?.update).toEqual({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Thinking" },
      });
      expect(replay.events[1]?.update).toEqual({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Answer" },
      });
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
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `event-${index}` },
              },
            }),
          ),
        );
        const replay = await second.readReplay(session);
        expect(replay.events.map((event) => event.seq)).toEqual([1, 2]);
        expect(replay.events.map((event) => event.update)).toEqual(
          expect.arrayContaining(
            [0, 1].map((index) => ({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `event-${index}` },
            })),
          ),
        );
        await second.markIncomplete(session);
        await expect(first.readReplay(session)).resolves.toEqual({ complete: false, events: [] });
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
        const session = {
          sessionId: "session-漢\0\ud800",
          sessionKey: "\udc00-key😀",
          cwd: "/é/e\u0301/台\0😀",
          complete: true,
        };
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
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "漢😀\0\ud800é e\u0301" },
            },
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
    const ledger = createTestAcpEventLedger({ now: () => 1000 });
    await ledger.startSession({
      sessionId: "acp-session-1",
      sessionKey: "acp:gateway-session-1",
      cwd: "/work",
      complete: true,
    });
    await ledger.recordUserPrompt({
      sessionId: "acp-session-1",
      sessionKey: "acp:gateway-session-1",
      runId: "run-1",
      prompt: [{ type: "text", text: "Question" }],
    });
    await ledger.recordUpdate({
      sessionId: "acp-session-1",
      sessionKey: "agent:main:acp:gateway-session-1",
      runId: "run-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Answer" },
      },
    });

    const replay = await ledger.readReplayBySessionKey({
      sessionKey: "agent:main:acp:gateway-session-1",
    });

    expect(replay.complete).toBe(true);
    expect(replay.sessionId).toBe("acp-session-1");
    expect(replay.sessionKey).toBe("agent:main:acp:gateway-session-1");
    expect(replay.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(replay.events.map((event) => event.runId)).toEqual(["run-1", "run-1"]);
    expect(replay.events.map((event) => event.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_message_chunk",
    ]);
  });
});
