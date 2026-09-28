import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptEvent,
  loadTranscriptEvents,
  replaceTranscriptEvents,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  runOpenClawAgentWriteAdmission,
  SQLITE_SESSION_WRITER_QUEUES,
} from "../../state/openclaw-agent-write-admission.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { openContextEngineTurnOutboxWorkerStore } from "./context-engine-turn-outbox-store.js";
import {
  drainContextEngineTurnOutbox,
  enqueueContextEngineTurnCommit,
} from "./context-engine-turn-outbox.js";
import { createPersistedContextEngineTurn as createPayload } from "./context-engine-turn-outbox.test-helpers.js";

const testStates: OpenClawTestState[] = [];
afterEach(async () => {
  for (const state of testStates.splice(0)) {
    await state.cleanup();
  }
});

async function createAdmissionFixture(incognito = false) {
  const state = await createOpenClawTestState({ prefix: "openclaw-outbox-admission-" });
  testStates.push(state);
  const database = openOpenClawAgentDatabase({
    agentId: "main",
    env: state.env,
    ...(incognito
      ? { path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }) }
      : {}),
  });
  const payload = await createPayload({
    advancementKey: "old-turn",
    databasePath: database.path,
    sequence: 1,
    sessionId: "session-a",
  });
  const target = payload.boundary.admission;
  const store = openContextEngineTurnOutboxWorkerStore({ agentId: "main", path: database.path });
  const commitTurn = vi.fn<NonNullable<ContextEngine["commitTurn"]>>(async () => ({
    status: "committed",
  }));
  const engine = {
    info: { id: "test", name: "Test" },
    ingest: async () => ({ ingested: true }),
    assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
    compact: async () => ({ ok: true, compacted: false }),
    commitTurn,
  } satisfies ContextEngine;
  const warn = vi.fn();
  const drain = () => drainContextEngineTurnOutbox({ store, engine, engineId: "test", warn });
  const reset = (context: "clear" | "preserve-tail" = "clear") =>
    resetSessionEntryLifecycle({
      storePath: target.storePath,
      target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
      resetBoundary: { context, reason: "reset", cwd: state.root },
      buildNextEntry: () => ({ sessionId: target.sessionId, updatedAt: 20 }),
    });
  const readRow = () =>
    database.db
      .prepare(
        "SELECT payload_json, attempt_count FROM context_engine_turn_outbox WHERE advancement_key = ?",
      )
      .get(target.logicalTurnId) as { payload_json: string; attempt_count: number } | undefined;
  enqueueContextEngineTurnCommit({ database, engineId: "test", payload });
  return { database, payload, target, store, commitTurn, warn, drain, reset, readRow };
}

describe("context-engine turn commit admission", () => {
  it.each(["clear", "preserve-tail"] as const)(
    "blocks delayed ready turns after %s reset, preserves evidence, and drains the new turn",
    async (context) => {
      const fixture = await createAdmissionFixture();
      await fixture.reset(context);
      const next = await createPayload({
        advancementKey: "new-turn",
        databasePath: fixture.database.path,
        sequence: 10,
        sessionId: fixture.target.sessionId,
      });
      enqueueContextEngineTurnCommit({
        database: fixture.database,
        engineId: "test",
        payload: next,
      });
      const result = await runWithSessionTranscriptReadFence(
        next.boundary.admission,
        fixture.drain,
      );
      expect(result).toEqual({ pending: false });
      expect(fixture.commitTurn).toHaveBeenCalledOnce();
      expect(fixture.commitTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          advancementKey: "new-turn",
          messages: next.messages,
          resetBoundary: {
            entryId: expect.any(String),
            rawSeq: expect.any(Number),
            generation: next.boundary.admission.generation,
          },
        }),
      );
      const blocked = fixture.readRow();
      expect(blocked?.attempt_count).toBe(0);
      expect(JSON.parse(blocked!.payload_json)).toEqual({
        ...fixture.payload,
        state: "blocked",
        failure: "stale",
      });
      expect(await fixture.drain()).toEqual({ pending: false });
      expect(fixture.readRow()).toEqual(blocked);
      expect(fixture.commitTurn).toHaveBeenCalledOnce();
    },
  );

  it.each(["branch", "rewrite", "session-rebound"] as const)(
    "blocks a ready turn invalidated by %s without deleting its payload",
    async (change) => {
      const fixture = await createAdmissionFixture();
      if (change === "rewrite") {
        await replaceTranscriptEvents(fixture.target, await loadTranscriptEvents(fixture.target));
      } else if (change === "branch") {
        await appendTranscriptEvent(fixture.target, {
          type: "leaf",
          id: "branch",
          targetId: fixture.target.entryId,
          parentId: fixture.payload.boundary.terminal.entryId,
        });
      } else {
        await upsertSessionEntryCore(fixture.target, {
          sessionId: "replacement-session",
          updatedAt: 20,
        });
      }
      expect(await fixture.drain()).toEqual({ pending: false });
      expect(fixture.commitTurn).not.toHaveBeenCalled();
      expect(JSON.parse(fixture.readRow()!.payload_json)).toEqual({
        ...fixture.payload,
        state: "blocked",
        failure: "stale",
      });
      expect(await fixture.drain()).toEqual({ pending: false });
      expect(fixture.commitTurn).not.toHaveBeenCalled();
    },
  );

  it("holds reset behind async plugin persistence and passes the admitted no-reset identity", async () => {
    const fixture = await createAdmissionFixture();
    const entered = createDeferredCore();
    const persist = createDeferredCore();
    const order: string[] = [];
    fixture.commitTurn.mockImplementationOnce(async () => {
      entered.resolve();
      await persist.promise;
      order.push("plugin-committed");
      return { status: "committed" };
    });
    const draining = fixture.drain();
    await entered.promise;
    // Observe the canonical writer queue while the plugin is still suspended;
    // ordering after releasing it alone could pass without holding admission.
    const writer = runOpenClawAgentWriteAdmission(
      { agentId: "main", path: fixture.database.path },
      () => {
        order.push("writer-admitted");
      },
    );
    const resetting = fixture.reset().then(() => {
      order.push("reset-committed");
    });
    try {
      expect(
        [...SQLITE_SESSION_WRITER_QUEUES.values()].some((queue) => queue.pending.length > 0),
      ).toBe(true);
      expect(order).toEqual([]);
    } finally {
      persist.resolve();
      await Promise.all([draining, writer, resetting]);
    }
    expect(order).toEqual(["plugin-committed", "writer-admitted", "reset-committed"]);
    expect(fixture.commitTurn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ resetBoundary: null }),
    );
    expect(fixture.readRow()).toBeUndefined();
  });

  it("retains unavailable transcript work for retry instead of treating it as stale", async () => {
    const fixture = await createAdmissionFixture();
    const reader = await import("../../config/sessions/session-transcript-admission.js");
    const read = vi
      .spyOn(reader, "acceptSessionTranscriptTurn")
      .mockRejectedValueOnce(new Error("transcript admission unavailable"));
    try {
      expect(await fixture.drain()).toEqual({ pending: true });
      expect(fixture.commitTurn).not.toHaveBeenCalled();
      expect(fixture.readRow()?.attempt_count).toBe(1);
      expect(JSON.parse(fixture.readRow()!.payload_json)).toEqual({
        ...fixture.payload,
        state: "ready",
      });
    } finally {
      read.mockRestore();
    }
    expect(await fixture.drain()).toEqual({ pending: false });
    expect(fixture.commitTurn).toHaveBeenCalledOnce();
  });

  it("keeps incognito commits on their existing process-held owner", async () => {
    const fixture = await createAdmissionFixture(true);
    expect(await fixture.drain()).toEqual({ pending: false });
    expect(fixture.commitTurn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ messages: fixture.payload.messages }),
    );
    expect(fixture.commitTurn.mock.calls[0]![0]).not.toHaveProperty("resetBoundary");
    expect(fixture.readRow()).toBeUndefined();
    expect(fs.existsSync(fixture.database.path)).toBe(false);
  });
});

it("does not permanently block a valid ready turn while its projection is unavailable", async () => {
  const fixture = await createAdmissionFixture();
  const setRebuilding = (value: number) =>
    fixture.database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = ? WHERE session_id = ?")
      .run(value, fixture.target.sessionId);
  setRebuilding(1);
  try {
    expect(await fixture.drain()).toEqual({ pending: true });
    expect(fixture.commitTurn).not.toHaveBeenCalled();
    expect(JSON.parse(fixture.readRow()!.payload_json).state).toBe("ready");
  } finally {
    setRebuilding(0);
  }
  expect(await fixture.drain()).toEqual({ pending: false });
  expect(fixture.commitTurn).toHaveBeenCalledOnce();
});
