import { afterEach, describe, expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db.js";
import { withTestDir as withTemporaryDir } from "../../../test-helpers/temp-dir.js";
import { createAcpParentStreamRecorder } from "./acp-parent-stream-store.sqlite.js";
import {
  listAcpParentStreamEventsForTest,
  recordAcpParentStreamEventsForTest as recordAcpParentStreamEvents,
} from "./acp-parent-stream-store.sqlite.test-support.js";

async function withTestDir(
  options: Parameters<typeof withTemporaryDir>[0],
  run: (stateDir: string) => Promise<void>,
) {
  return withTemporaryDir(options, async (stateDir) => {
    try {
      await run(stateDir);
    } finally {
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      await closeOpenClawStateDatabaseAsync();
    }
  });
}

function seedSession(options: { agentId: string; env: NodeJS.ProcessEnv }, sessionKey: string) {
  runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<
      Pick<OpenClawAgentKyselyDatabase, "session_nodes" | "session_windows">
    >(database.db);
    executeSqliteQuerySync(
      database.db,
      db.insertInto("session_nodes").values({
        session_key: sessionKey,
        current_session_id: "session-1",
        entry_json: "{}",
        updated_at: 1,
      }),
    );
    executeSqliteQuerySync(
      database.db,
      db.insertInto("session_windows").values({
        session_id: "session-1",
        session_key: sessionKey,
        session_scope: "conversation",
        created_at: 1,
        updated_at: 1,
      }),
    );
  }, options);
}

describe("ACP parent stream SQLite store", () => {
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
  });

  it("orders run events and removes them with the child session", async () => {
    await withTestDir({ prefix: "openclaw-acp-parent-stream-" }, async (stateDir) => {
      const options = {
        agentId: "codex",
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      };
      seedSession(options, "agent:codex:acp:child");

      await recordAcpParentStreamEvents({
        ...options,
        sessionId: "session-1",
        runId: "run-1",
        events: [
          { createdAt: 10, event: { kind: "assistant_delta", delta: "one" } },
          { createdAt: 11, event: { kind: "lifecycle", phase: "end" } },
        ],
      });

      expect(
        listAcpParentStreamEventsForTest({ ...options, sessionId: "session-1", runId: "run-1" }),
      ).toEqual([
        { kind: "assistant_delta", delta: "one" },
        { kind: "lifecycle", phase: "end" },
      ]);

      runOpenClawAgentWriteTransaction((database) => {
        const db = getNodeSqliteKysely<Pick<OpenClawAgentKyselyDatabase, "session_windows">>(
          database.db,
        );
        executeSqliteQuerySync(
          database.db,
          db.deleteFrom("session_windows").where("session_id", "=", "session-1"),
        );
      }, options);
      expect(
        listAcpParentStreamEventsForTest({ ...options, sessionId: "session-1", runId: "run-1" }),
      ).toEqual([]);
    });
  });

  it("drops unserializable events without blocking later diagnostics", async () => {
    await withTestDir({ prefix: "openclaw-acp-parent-stream-invalid-" }, async (stateDir) => {
      const options = {
        agentId: "codex",
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      };
      seedSession(options, "agent:codex:acp:invalid");
      const circular: Record<string, unknown> = { kind: "circular" };
      circular.self = circular;

      await recordAcpParentStreamEvents({
        ...options,
        sessionId: "session-1",
        runId: "run-1",
        events: [
          { createdAt: 10, event: { toJSON: () => undefined } },
          { createdAt: 11, event: circular },
          { createdAt: 12, event: { kind: "lifecycle", phase: "end" } },
        ],
      });

      expect(
        listAcpParentStreamEventsForTest({ ...options, sessionId: "session-1", runId: "run-1" }),
      ).toEqual([{ kind: "lifecycle", phase: "end" }]);
    });
  });
  it("keeps captured inputs and sequence allocation in the agent writer FIFO", async () => {
    await withTestDir({ prefix: "acp-parent-fifo-" }, async (stateDir) => {
      const target = { agentId: "main", env: { OPENCLAW_STATE_DIR: stateDir } };
      seedSession(target, "agent:main:acp:child");
      const recorder = createAcpParentStreamRecorder({
        ...target,
        sessionId: "session-1",
        runId: "fifo",
      });
      const gate = createDeferredCore();
      const ahead = runOpenClawAgentWriteAdmission(target, () => gate.promise);
      const events = [{ event: { kind: "first" }, createdAt: 1 }];
      const first = recorder.record(events);
      const between = runOpenClawAgentWriteAdmission(target, () =>
        listAcpParentStreamEventsForTest({
          ...target,
          sessionId: "session-1",
          runId: "fifo",
        }),
      );
      const second = recorder.record([{ event: { kind: "second" }, createdAt: 2 }]);
      events[0]!.event.kind = "mutated";
      try {
        gate.resolve();
        await ahead;
        expect(await first).toEqual({ ok: true, value: undefined });
        expect(await between).toEqual([{ kind: "first" }]);
        expect(await second).toEqual({ ok: true, value: undefined });
        expect(
          listAcpParentStreamEventsForTest({ ...target, sessionId: "session-1", runId: "fifo" }),
        ).toEqual([{ kind: "first" }, { kind: "second" }]);
      } finally {
        gate.resolve();
        await Promise.allSettled([ahead, first, between, second]);
        await recorder.close();
      }
    });
  });

  it("returns a proven rollback with native error identity and no partial batch", async () => {
    await withTestDir({ prefix: "acp-parent-rollback-" }, async (stateDir) => {
      const target = { agentId: "main", env: { OPENCLAW_STATE_DIR: stateDir } };
      seedSession(target, "agent:main:acp:child");
      const { db } = openOpenClawAgentDatabase(target);
      const recorder = createAcpParentStreamRecorder({
        ...target,
        sessionId: "session-1",
        runId: "rollback",
      });
      try {
        const result = await recorder.record([
          { event: { kind: "first" }, createdAt: 1 },
          { event: { kind: "second" }, createdAt: Number.NaN },
        ]);
        expect(result.ok).toBe(false);
        if (result.ok) {
          throw new Error("Expected SQLite to refuse the invalid timestamp");
        }
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 1299 });
        expect(
          listAcpParentStreamEventsForTest({
            ...target,
            sessionId: "session-1",
            runId: "rollback",
          }),
        ).toEqual([]);
        expect(await recorder.record([{ event: { kind: "after" }, createdAt: 3 }])).toEqual({
          ok: true,
          value: undefined,
        });
        expect(db.prepare("SELECT seq FROM acp_parent_stream_events").all()).toEqual([{ seq: 0 }]);
      } finally {
        await recorder.close();
      }
    });
  });
});
