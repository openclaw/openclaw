import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type {
  TranscriptTurnAdmission,
  TranscriptTurnBoundary,
} from "../../config/sessions/transcript-entry-anchor.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import type { ContextEngineLogicalTurnLease } from "./context-engine-logical-turn.js";
import { drainPendingContextEngineTurnsBeforeRun } from "./context-engine-turn-attempt.js";
import { openContextEngineTurnOutboxWorkerStore } from "./context-engine-turn-outbox-store.js";
import {
  acceptContextEngineTurnIntent,
  drainContextEngineTurnOutbox,
  enqueueContextEngineTurnCommit,
  enqueueContextEngineTurnIntent,
  isRetryableContextEngineTurnReadFailure,
  recoverContextEngineTurnOutbox,
} from "./context-engine-turn-outbox.js";
import { bindSqliteWorkerBackend } from "./context-engine-turn-outbox.worker.js";

const tempDirs: string[] = [];
type ContextEngineTurnOutboxPayload = Parameters<
  typeof enqueueContextEngineTurnCommit
>[0]["payload"];

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await cleanupSessionStateForTest({ stateDir: tempDir });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createPayload(params: {
  advancementKey: string;
  databasePath: string;
  sequence: number;
  sessionId: string;
}): ContextEngineTurnOutboxPayload {
  const anchor = {
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: `agent:main:${params.sessionId}`,
    storePath: params.databasePath,
    generation: "generation-1",
    entryId: `${params.advancementKey}:user`,
    rawSeq: params.sequence,
    effectiveParentId: null,
    activeMessagePosition: params.sequence,
  };
  const boundary = {
    admission: {
      ...anchor,
      logicalTurnId: params.advancementKey,
      role: "user" as const,
    },
    terminal: {
      ...anchor,
      entryId: `${params.advancementKey}:assistant`,
      rawSeq: params.sequence + 1,
      effectiveParentId: anchor.entryId,
      activeMessagePosition: params.sequence + 1,
    },
  } satisfies TranscriptTurnBoundary;
  return {
    boundary,
    isHeartbeat: false,
    messages: [],
  };
}

function createStateDir() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-context-outbox-"));
  tempDirs.push(stateDir);
  return stateDir;
}

function createDatabase() {
  return openOpenClawAgentDatabase({
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: createStateDir() },
  });
}

function createEngine<T extends NonNullable<ContextEngine["commitTurn"]>>(
  commitTurn: T,
  durable = true,
) {
  return {
    info: {
      id: "test",
      name: "Test",
      ...(durable
        ? {
            transcriptSemantics: {
              currentTurnFence: "before-current-turn-entry-v1" as const,
              turnAdvancementIdempotency: "atomic-idempotent-v1" as const,
            },
          }
        : {}),
    },
    ingest: async () => ({ ingested: true }),
    assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
    compact: async () => ({ ok: true, compacted: false }),
    commitTurn,
  } satisfies ContextEngine;
}

function createLease(engine: ContextEngine) {
  return {
    engine,
    effectiveEngine: engine,
    effectiveEngineId: "test",
    effectiveEnginePluginId: undefined,
    degraded: false,
    degradedReason: undefined,
    selectForHost: vi.fn(),
    degradeBeforeStart: vi.fn(),
    begin: vi.fn(),
    deferDisposalUntil: vi.fn(),
    dispose: vi.fn(async () => undefined),
  } satisfies ContextEngineLogicalTurnLease;
}

async function createTranscript(sessionId: string, content = "current") {
  const stateDir = createStateDir();
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(stateDir, "sessions.json"),
  };
  await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
  const current = await appendTranscriptMessage(target, {
    message: { role: "user", content },
    now: 1_000,
  });
  if (!current?.anchor) {
    throw new Error("expected admitted transcript entry");
  }
  const admission = {
    ...current.anchor,
    logicalTurnId: `${sessionId}-logical-turn`,
    role: "user" as const,
  } satisfies TranscriptTurnAdmission;
  const database = openOpenClawAgentDatabase({ agentId: "main", path: admission.storePath });
  return { stateDir, target, current, anchor: current.anchor, admission, database };
}

describe("context-engine turn outbox", () => {
  it("retries only transcript failures that can make progress", () => {
    expect(isRetryableContextEngineTurnReadFailure("projection-unavailable")).toBe(true);
    expect(isRetryableContextEngineTurnReadFailure("too-large")).toBe(false);
    expect(isRetryableContextEngineTurnReadFailure("stale")).toBe(false);
  });

  it.each(["invalid-result", "missing-state"] as const)(
    "retains a queued turn with %s",
    async (failure) => {
      const database = createDatabase();
      const payload = createPayload({
        advancementKey: `session-a:${failure}`,
        databasePath: database.path,
        sequence: 1,
        sessionId: "session-a",
      });
      enqueueContextEngineTurnCommit({ database, engineId: "test", payload });
      if (failure === "missing-state") {
        database.db
          .prepare(
            "UPDATE context_engine_turn_outbox SET payload_json = '{}' WHERE advancement_key = ?",
          )
          .run(payload.boundary.admission.logicalTurnId);
      }
      let valid = failure === "missing-state";
      const commitTurn = vi.fn(async () =>
        valid ? { status: "committed" as const } : ({ status: "ignored" } as never),
      );
      const engine = createEngine(commitTurn, false);
      const warn = vi.fn();
      const store = openContextEngineTurnOutboxWorkerStore({
        agentId: database.agentId,
        path: database.path,
      });
      const row = () =>
        database.db
          .prepare(
            "SELECT attempt_count, last_error FROM context_engine_turn_outbox WHERE advancement_key = ?",
          )
          .get(payload.boundary.admission.logicalTurnId);
      const result = await drainContextEngineTurnOutbox({ store, engine, engineId: "test", warn });
      if (failure === "missing-state") {
        expect(result.pending).toBe(true);
        expect(commitTurn).not.toHaveBeenCalled();
        expect(row()).toBeDefined();
        return;
      }
      expect(row()).toEqual({
        attempt_count: 1,
        last_error: "invalid commitTurn result status: ignored",
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("durable turn advancement remains queued"),
      );
      valid = true;
      const onCommitted = vi.fn(() => {
        throw new Error("maintenance handoff failed");
      });
      await drainContextEngineTurnOutbox({ store, engine, engineId: "test", onCommitted, warn });
      expect(onCommitted).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ advancementKey: payload.boundary.admission.logicalTurnId }),
      );
      expect(warn).toHaveBeenCalledWith(
        "[context-engine] committed turn notification failed: maintenance handoff failed",
      );
      expect(row()).toBeUndefined();
    },
  );

  it.each(["accepted", "admission-only"] as const)(
    "recovers %s prior work before recording the next dispatch",
    async (state) => {
      const accepted = state === "accepted";
      const {
        target,
        current: admitted,
        admission,
        database,
      } = await createTranscript(accepted ? "recovered-turn" : "unaccepted-turn", "first");
      enqueueContextEngineTurnIntent({
        admission,
        database,
        engineId: "test",
        isHeartbeat: accepted,
      });
      const terminal = await appendTranscriptMessage(target, {
        message: { role: "assistant", content: accepted ? "first answer" : "rejected fallback" },
        parentId: admitted.messageId,
        now: 2_000,
      });
      if (!terminal?.anchor) {
        throw new Error("expected terminal transcript entry");
      }
      if (accepted) {
        acceptContextEngineTurnIntent({
          boundary: { admission, terminal: terminal.anchor },
          database,
          engineId: "test",
          isHeartbeat: true,
          runtimeContext: {
            provider: "anthropic",
            modelId: "claude-sonnet-4-6",
            tokenBudget: 180_000,
            modelContextWindow: 200_000,
          },
        });
      }
      const current = await appendTranscriptMessage(target, {
        message: { role: "user", content: "second" },
        parentId: terminal.messageId,
        now: 3_000,
      });
      if (!current?.anchor) {
        throw new Error("expected current transcript entry");
      }
      const currentAdmission = {
        ...current.anchor,
        logicalTurnId: "current-logical-turn",
        role: "user" as const,
      } satisfies TranscriptTurnAdmission;
      const currentMessage = { role: "user" as const, content: "second", timestamp: 3_000 };
      const recorder = createUserTurnTranscriptRecorder({
        message: currentMessage,
        target: async () => undefined,
      });
      const commitTurn = vi.fn<NonNullable<ContextEngine["commitTurn"]>>(async () => ({
        status: "committed",
      }));
      const lease = createLease(createEngine(commitTurn));
      await drainPendingContextEngineTurnsBeforeRun({
        admission: accepted ? undefined : currentAdmission,
        isHeartbeat: false,
        lease,
        ...(accepted ? { recorder, sessionTarget: target } : {}),
      });
      if (accepted) {
        expect(commitTurn).toHaveBeenCalledOnce();
        expect(commitTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            advancementKey: admission.logicalTurnId,
            isHeartbeat: true,
            runtimeContext: {
              provider: "anthropic",
              modelId: "claude-sonnet-4-6",
              tokenBudget: 180_000,
              modelContextWindow: 200_000,
            },
            messages: [
              { role: "user", content: "first" },
              { role: "assistant", content: "first answer" },
            ],
          }),
        );
        expect(
          database.db.prepare("SELECT advancement_key FROM context_engine_turn_outbox").all(),
        ).toHaveLength(0);
        expect(commitTurn.mock.calls[0]?.[0]).not.toHaveProperty("prePromptMessageCount");
        recorder.markRuntimePersisted(currentMessage, currentAdmission);
        // The dispatch wait settles admission in the agent database worker.
        expect(recorder.hasRuntimePersistencePending()).toBe(true);
        await recorder.waitForRuntimePersistence();
      } else {
        expect(commitTurn).not.toHaveBeenCalled();
      }
      const queued = database.db
        .prepare("SELECT advancement_key, payload_json FROM context_engine_turn_outbox")
        .all() as Array<{ advancement_key: string; payload_json: string }>;
      expect(queued).toHaveLength(1);
      expect(queued[0]?.advancement_key).toBe(currentAdmission.logicalTurnId);
      expect(JSON.parse(queued[0]?.payload_json ?? "{}")).toMatchObject({
        state: "admitted",
        isHeartbeat: false,
      });
      if (accepted) {
        expect(lease.degradeBeforeStart).not.toHaveBeenCalled();
        await drainPendingContextEngineTurnsBeforeRun({ admission: undefined, lease });
        expect(lease.degradeBeforeStart).not.toHaveBeenCalled();
      }
    },
  );

  it("retains unrecoverable accepted recovery as a terminal marker without blocking later turns", async () => {
    const database = createDatabase();
    const payload = createPayload({
      advancementKey: "session-a:unrecoverable",
      databasePath: database.path,
      sequence: 1,
      sessionId: "session-a",
    });
    enqueueContextEngineTurnIntent({
      admission: payload.boundary.admission,
      database,
      engineId: "test",
      isHeartbeat: false,
    });
    acceptContextEngineTurnIntent({
      boundary: payload.boundary,
      database,
      engineId: "test",
      isHeartbeat: false,
    });
    const warn = vi.fn();

    recoverContextEngineTurnOutbox({
      database,
      engineId: "test",
      sessionId: payload.boundary.admission.sessionId,
      warn,
    });

    const queued = database.db
      .prepare("SELECT payload_json FROM context_engine_turn_outbox WHERE advancement_key = ?")
      .get(payload.boundary.admission.logicalTurnId) as { payload_json: string };
    expect(JSON.parse(queued.payload_json)).toMatchObject({
      state: "blocked",
      failure: "session-rebound",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("blocked unrecoverable turn advancement"),
    );

    enqueueContextEngineTurnCommit({
      database,
      engineId: "test",
      payload: createPayload({
        advancementKey: "session-a:later-ready",
        databasePath: database.path,
        sequence: 3,
        sessionId: "session-a",
      }),
    });

    const engine = createEngine(vi.fn(async () => ({ status: "committed" as const })));
    const lease = createLease(engine);
    const { degradeBeforeStart } = lease;
    const currentAdmission = {
      ...payload.boundary.admission,
      logicalTurnId: "session-a:current",
    };

    await drainPendingContextEngineTurnsBeforeRun({
      admission: currentAdmission,
      lease,
      warn,
    });

    expect(engine.commitTurn).toHaveBeenCalledOnce();
    expect(engine.commitTurn).toHaveBeenCalledWith(
      expect.objectContaining({ advancementKey: "session-a:later-ready" }),
    );
    expect(degradeBeforeStart).not.toHaveBeenCalled();
    expect(
      database.db
        .prepare("SELECT 1 FROM context_engine_turn_outbox WHERE advancement_key = ?")
        .get(payload.boundary.admission.logicalTurnId),
    ).toBeDefined();
    expect(
      database.db
        .prepare("SELECT 1 FROM context_engine_turn_outbox WHERE advancement_key = ?")
        .get("session-a:later-ready"),
    ).toBeUndefined();
    expect(
      JSON.parse(
        (
          database.db
            .prepare(
              "SELECT payload_json FROM context_engine_turn_outbox WHERE advancement_key = ?",
            )
            .get(currentAdmission.logicalTurnId) as { payload_json: string }
        ).payload_json,
      ),
    ).toMatchObject({ state: "admitted" });
  });

  it("does not let later same-session turns overtake a failed commit", async () => {
    const database = createDatabase();
    const enqueue = (advancementKey: string, sessionId: string, sequence: number) =>
      enqueueContextEngineTurnCommit({
        database,
        engineId: "test",
        payload: createPayload({
          advancementKey,
          databasePath: database.path,
          sequence,
          sessionId,
        }),
      });
    enqueue("session-a:z-first", "session-a", 1);
    for (let turn = 2; turn <= 17; turn += 1) {
      enqueue(turn === 2 ? "session-a:a-second" : `session-a:${turn}`, "session-a", turn * 2 - 1);
    }
    enqueue("session-b:1", "session-b", 1);
    database.db.exec(`
      UPDATE context_engine_turn_outbox SET created_at = CASE
        WHEN session_id = 'session-a' THEN 1
        ELSE 100
      END;
    `);

    let failFirstTurn = true;
    const commitTurn = vi.fn(async ({ advancementKey }: { advancementKey: string }) => {
      if (advancementKey === "session-a:z-first" && failFirstTurn) {
        throw new Error("temporary failure");
      }
      return { status: "committed" as const };
    });
    const engine = createEngine(commitTurn, false);
    const warn = vi.fn();

    const store = openContextEngineTurnOutboxWorkerStore({
      agentId: database.agentId,
      path: database.path,
    });
    await drainContextEngineTurnOutbox({ store, engine, engineId: "test", warn });

    expect(commitTurn.mock.calls.map(([call]) => call.advancementKey)).toEqual([
      "session-a:z-first",
      "session-b:1",
    ]);
    failFirstTurn = false;

    await drainContextEngineTurnOutbox({
      store,
      engine,
      engineId: "test",
      limit: 2,
      warn,
    });

    expect(commitTurn.mock.calls.map(([call]) => call.advancementKey)).toEqual([
      "session-a:z-first",
      "session-b:1",
      "session-a:z-first",
      "session-a:a-second",
    ]);

    await drainContextEngineTurnOutbox({
      store,
      engine,
      engineId: "test",
      limit: 1,
      warn,
    });

    expect(commitTurn.mock.calls.map(([call]) => call.advancementKey)).toEqual([
      "session-a:z-first",
      "session-b:1",
      "session-a:z-first",
      "session-a:a-second",
      "session-a:3",
    ]);
  });

  it("retries the current session before the next run and degrades if it stays blocked", async () => {
    const database = createDatabase();
    const payload = createPayload({
      advancementKey: "session-a:retry",
      databasePath: database.path,
      sequence: 1,
      sessionId: "session-a",
    });
    Object.assign(payload, {
      runtimeContext: {
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        tokenBudget: 180_000,
        modelContextWindow: 200_000,
      },
    });
    enqueueContextEngineTurnCommit({ database, engineId: "test", payload });

    let blocked = true;
    const commitTurn = vi.fn<NonNullable<ContextEngine["commitTurn"]>>(async () => {
      if (blocked) {
        throw new Error("temporary failure");
      }
      return { status: "committed" as const };
    });
    const engine = createEngine(commitTurn);
    const lease = createLease(engine);
    const { degradeBeforeStart } = lease;
    const warn = vi.fn();

    const store = openContextEngineTurnOutboxWorkerStore({
      agentId: database.agentId,
      path: database.path,
    });
    await drainContextEngineTurnOutbox({ store, engine, engineId: "test", warn });
    blocked = false;
    await drainPendingContextEngineTurnsBeforeRun({
      admission: payload.boundary.admission,
      lease,
      warn,
    });

    expect(commitTurn).toHaveBeenCalledTimes(2);
    for (const [call] of commitTurn.mock.calls) {
      expect(call).toMatchObject({
        runtimeContext: { tokenBudget: 180_000, modelContextWindow: 200_000 },
      });
    }
    expect(degradeBeforeStart).not.toHaveBeenCalled();

    enqueueContextEngineTurnCommit({
      database,
      engineId: "test",
      payload: createPayload({
        advancementKey: "session-a:blocked",
        databasePath: database.path,
        sequence: 3,
        sessionId: "session-a",
      }),
    });
    blocked = true;
    await drainPendingContextEngineTurnsBeforeRun({
      admission: payload.boundary.admission,
      lease,
      warn,
    });

    expect(degradeBeforeStart).toHaveBeenCalledWith(
      "pending durable turn advancement could not be completed before the next turn",
    );
  });

  it("queues a runtime admission reported inside a session write lane behind that lane", async () => {
    const { stateDir, target, admission, database } = await createTranscript("lane-turn");
    const currentMessage = { role: "user" as const, content: "current", timestamp: 1_000 };
    const recorder = createUserTurnTranscriptRecorder({
      message: currentMessage,
      target: async () => undefined,
    });
    const engine = createEngine(async () => ({ status: "committed" }));
    const lease = createLease(engine);
    await drainPendingContextEngineTurnsBeforeRun({
      admission: undefined,
      lease,
      recorder,
      sessionTarget: target,
    });

    // An unrelated store may have queued work when runtime persistence is reported.
    const otherDatabase = openOpenClawAgentDatabase({
      agentId: "other",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const releaseOther = createDeferredCore();
    const otherEntered = createDeferredCore();
    const otherWrite = runOpenClawAgentWriteAdmission(
      { agentId: otherDatabase.agentId, path: otherDatabase.path },
      async () => {
        otherEntered.resolve();
        await releaseOther.promise;
      },
    );
    await otherEntered.promise;
    const otherQueuedWrite = runOpenClawAgentWriteAdmission(
      { agentId: otherDatabase.agentId, path: otherDatabase.path },
      () => undefined,
    );
    const databaseAccess = vi.spyOn(agentDatabase, "withOpenClawAgentDatabaseAsync");
    const accessesToTarget = () =>
      databaseAccess.mock.calls.filter(([options]) => options.path === database.path);
    try {
      // Observe the real database entry: worker I/O alone can delay even a reentrant write.
      const accessesInsideLane = await runOpenClawAgentWriteAdmission(
        { agentId: database.agentId, path: database.path },
        () => {
          recorder.markRuntimePersisted(currentMessage, admission);
          return accessesToTarget().length;
        },
      );
      await recorder.waitForRuntimePersistence();

      expect(accessesInsideLane).toBe(0);
      expect(accessesToTarget()).toHaveLength(1);
      expect(lease.degradeBeforeStart).not.toHaveBeenCalled();
      const queued = database.db
        .prepare("SELECT payload_json FROM context_engine_turn_outbox WHERE advancement_key = ?")
        .get(admission.logicalTurnId) as { payload_json: string } | undefined;
      expect(JSON.parse(queued?.payload_json ?? "{}")).toMatchObject({ state: "admitted" });
    } finally {
      databaseAccess.mockRestore();
      releaseOther.resolve();
      await Promise.all([otherWrite, otherQueuedWrite]);
    }
  });

  it("rejects the pre-dispatch runtime wait when the admission write fails", async () => {
    const { anchor } = await createTranscript("failed-admission-turn");
    const currentMessage = { role: "user" as const, content: "current", timestamp: 1_000 };
    const recorder = createUserTurnTranscriptRecorder({
      message: currentMessage,
      target: async () => undefined,
    });
    recorder.setAdmissionHandler?.(async () => {
      throw new Error("admission write failed");
    });

    recorder.markRuntimePersisted(currentMessage, anchor);

    expect(recorder.hasRuntimePersistencePending()).toBe(true);
    await expect(recorder.waitForRuntimePersistence()).rejects.toThrow("admission write failed");
  });

  it("installs the outbox schema once per worker connection, not per command", async () => {
    const { target, database } = await createTranscript("schema-turn");
    const databasePath = database.path;
    // A fresh connection has not ensured the lazy outbox DDL yet, as in a new worker.
    const connection = new DatabaseSync(databasePath);
    try {
      const exec = vi.spyOn(connection, "exec");
      const backend = bindSqliteWorkerBackend(undefined, {
        databasePath,
        database: connection,
        admit: () => undefined,
      });
      const command = {
        type: "hasPending" as const,
        input: { engineId: "test", sessionId: target.sessionId },
      };
      expect(backend.execute(command)).toBe(false);
      expect(backend.execute(command)).toBe(false);
      const outboxDdl = exec.mock.calls.filter(([sql]) =>
        sql.includes("CREATE TABLE IF NOT EXISTS context_engine_turn_outbox"),
      );
      expect(outboxDdl).toHaveLength(1);
    } finally {
      connection.close();
    }
  });
});
