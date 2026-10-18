import { describe, expect, it } from "vitest";
import { writeSessionEntry } from "../../../config/sessions/session-accessor.sqlite-entry-store.js";
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

async function withStream(
  runId: string,
  run: (
    target: { agentId: string; env: NodeJS.ProcessEnv; sessionId: string; runId: string },
    list: () => ReturnType<typeof listAcpParentStreamEventsForTest>,
  ) => Promise<void>,
  agentId = "main",
) {
  return withTemporaryDir({ prefix: `acp-parent-${runId}-` }, async (stateDir) => {
    try {
      const target = {
        agentId,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        sessionId: "session-1",
        runId,
      };
      seedSession(target, `agent:${agentId}:acp:child`);
      await run(target, () => listAcpParentStreamEventsForTest(target));
    } finally {
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      await closeOpenClawStateDatabaseAsync();
    }
  });
}

function seedSession(options: { agentId: string; env: NodeJS.ProcessEnv }, sessionKey: string) {
  runOpenClawAgentWriteTransaction(
    (database) => writeSessionEntry(database, sessionKey, { sessionId: "session-1", updatedAt: 1 }),
    options,
  );
}

describe("ACP parent stream SQLite store", () => {
  it("orders run events and removes them with the child session", async () => {
    await withStream(
      "run-1",
      async (target, list) => {
        await recordAcpParentStreamEvents({
          ...target,
          events: [
            { createdAt: 10, event: { kind: "assistant_delta", delta: "one" } },
            { createdAt: 11, event: { kind: "lifecycle", phase: "end" } },
          ],
        });

        expect(list()).toEqual([
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
        }, target);
        expect(list()).toEqual([]);
      },
      "codex",
    );
  });

  it("drops unserializable events without blocking later diagnostics", async () => {
    await withStream(
      "run-1",
      async (target, list) => {
        const circular: Record<string, unknown> = { kind: "circular" };
        circular.self = circular;

        await recordAcpParentStreamEvents({
          ...target,
          events: [
            { createdAt: 10, event: { toJSON: () => undefined } },
            { createdAt: 11, event: circular },
            { createdAt: 12, event: { kind: "lifecycle", phase: "end" } },
          ],
        });

        expect(list()).toEqual([{ kind: "lifecycle", phase: "end" }]);
      },
      "codex",
    );
  });
  it("keeps captured inputs and sequence allocation in the agent writer FIFO", async () => {
    await withStream("fifo", async (target, list) => {
      const recorder = createAcpParentStreamRecorder(target);
      const gate = createDeferredCore();
      const ahead = runOpenClawAgentWriteAdmission(target, () => gate.promise);
      const events = [{ event: { kind: "first" }, createdAt: 1 }];
      const first = recorder.record(events);
      const between = runOpenClawAgentWriteAdmission(target, list);
      const second = recorder.record([{ event: { kind: "second" }, createdAt: 2 }]);
      events[0]!.event.kind = "mutated";
      try {
        gate.resolve();
        await ahead;
        expect(await first).toEqual({ ok: true, value: undefined });
        expect(await between).toEqual([{ kind: "first" }]);
        expect(await second).toEqual({ ok: true, value: undefined });
        expect(list()).toEqual([{ kind: "first" }, { kind: "second" }]);
      } finally {
        gate.resolve();
        await Promise.allSettled([ahead, first, between, second]);
        await recorder.close();
      }
    });
  });

  it("returns a proven rollback with native error identity and no partial batch", async () => {
    await withStream("rollback", async (target, list) => {
      const { db } = openOpenClawAgentDatabase(target);
      const recorder = createAcpParentStreamRecorder(target);
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
        expect(list()).toEqual([]);
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
