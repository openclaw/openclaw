import assert from "node:assert/strict";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  patchSessionEntryCore,
  readActiveTranscriptEntryAnchor,
} from "../../config/sessions/session-accessor.js";
import { readClosedTranscriptTurnInDatabase } from "../../config/sessions/session-accessor.transcript-range.worker.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../state/openclaw-agent-write-admission-state.js";
import * as workerWriteAdmission from "../../state/openclaw-agent-write-admission.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  drainPendingContextEngineTurnsBeforeRun,
  finalizeAcceptedContextEngineTurn,
} from "./context-engine-turn-attempt.js";
import {
  enqueueContextEngineTurnCommit,
  enqueueContextEngineTurnIntent,
} from "./context-engine-turn-outbox.kernel.worker.js";
import {
  appendTurnMessage,
  createTurnBoundary,
  createTurnFacts,
  createTurnEngine,
  createTurnLease,
} from "./context-engine-turn.test-support.js";

const acceptedMessages = [
  { role: "user", content: "current" },
  { role: "assistant", content: "answer" },
];

const sessionDirs = useSessionStoreTempDirs(
  (cleanup) =>
    afterAll(async () => {
      await cleanup();
      clearRuntimeConfigSnapshot();
    }),
  "openclaw-context-turn-range-",
);

async function seedTurnSession(
  target: Parameters<typeof patchSessionEntryCore>[0] & { sessionId: string },
) {
  const entry = { sessionId: target.sessionId, updatedAt: 1 };
  // Queue assertions measure outbox settlement, independent of automatic session housekeeping.
  await patchSessionEntryCore(target, () => entry, {
    fallbackEntry: entry,
    skipMaintenance: true,
    workerGuard: {},
  });
}

function createDurableLease() {
  const commitTurn = vi.fn<NonNullable<ContextEngine["commitTurn"]>>(async () => ({
    status: "committed",
  }));
  const lease = createTurnLease(createTurnEngine(commitTurn));
  return { commitTurn, lease, warn: vi.fn() };
}

async function holdWorker(database: ReturnType<typeof openOpenClawAgentDatabase>) {
  const admitted = createDeferredCore();
  const release = createDeferredCore();
  const worker = workerWriteAdmission.runOpenClawAgentWorkerWrite(
    { agentId: database.agentId, path: database.path },
    async () => {
      admitted.resolve();
      await release.promise;
    },
  );
  await admitted.promise;
  return { worker, release };
}

async function createAcceptedTurnFixture(
  params: {
    answer?: string;
    metadataCount?: number;
    prefix?: string[];
  } = {},
) {
  const sessionId = "accepted-turn";
  const tempDir = sessionDirs.make();
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(tempDir, "sessions.json"),
  };
  await seedTurnSession(target);
  let parentId: string | undefined;
  for (const [index, content] of (params.prefix ?? []).entries()) {
    const entry = await appendTranscriptMessage(target, {
      message: { role: "assistant", content },
      parentId,
      now: 1_000 + index,
    });
    parentId = entry?.messageId;
  }
  const priorId = parentId;
  const admitted = await appendTurnMessage(target, "user", "current", 10_000, parentId);
  parentId = admitted?.messageId;
  for (let index = 0; index < (params.metadataCount ?? 0); index += 1) {
    const id = `metadata-${index}`;
    await appendTranscriptEvent(target, {
      type: "custom",
      id,
      parentId,
      timestamp: new Date(10_001 + index).toISOString(),
      customType: "turn-progress",
      data: { index },
    });
    parentId = id;
  }
  const terminal = await appendTurnMessage(
    target,
    "assistant",
    params.answer ?? "answer",
    11_000,
    parentId,
  );
  assert(admitted?.anchor && terminal?.anchor, "expected admitted turn transcript");
  const admission = {
    ...admitted.anchor,
    logicalTurnId: "logical-turn",
    role: "user" as const,
  };
  const database = openOpenClawAgentDatabase({
    agentId: target.agentId,
    path: admission.storePath,
  });
  const enqueue = (candidate = admission) =>
    enqueueContextEngineTurnIntent({
      admission: candidate,
      database,
      engineId: "test",
    });
  enqueue();
  const readRow = (key = admission.logicalTurnId) =>
    database.db
      .prepare(
        "SELECT payload_json, attempt_count, last_error FROM context_engine_turn_outbox WHERE advancement_key = ?",
      )
      .get(key) as
      | { payload_json: string; attempt_count: number; last_error: string | null }
      | undefined;
  const readPayload = (key = admission.logicalTurnId): unknown => {
    const row = readRow(key);
    return row ? JSON.parse(row.payload_json) : undefined;
  };
  const boundary = { admission, terminal: terminal.anchor };
  const defaults = { facts: createTurnFacts(boundary, target), ...createDurableLease() };
  return {
    admission,
    enqueue,
    database,
    target,
    priorId,
    readRow,
    readPayload,
    readRange: (maxEvents: number) =>
      readClosedTranscriptTurnInDatabase(database.db, {
        boundary,
        maxEvents,
        maxBytes: 1024,
      }),
    ...defaults,
    finalize: (overrides: Partial<Parameters<typeof finalizeAcceptedContextEngineTurn>[0]> = {}) =>
      finalizeAcceptedContextEngineTurn({ ...defaults, ...overrides }),
    drain: (nextAdmission?: typeof boundary.admission) =>
      drainPendingContextEngineTurnsBeforeRun({ ...defaults, admission: nextAdmission }),
  };
}

describe("accepted context-engine turn finalization", () => {
  it("commits a running turn once after confirming a persisted steer", async () => {
    setRuntimeConfigSnapshot({});
    const target = {
      agentId: "main",
      sessionId: "steered-turn",
      sessionKey: "agent:main:steered-turn",
      storePath: path.join(sessionDirs.make(), "sessions.json"),
      sessionEntry: undefined,
    };
    await seedTurnSession(target);
    const recorder = createUserTurnTranscriptRecorder({
      target,
      input: { text: "Start the answer" },
      updateMode: "none",
    });
    const { commitTurn, lease } = createDurableLease();
    await drainPendingContextEngineTurnsBeforeRun({
      admission: undefined,
      recorder,
      sessionTarget: target,
      lease,
    });
    await recorder.persistApproved();
    recorder.markSentToProvider?.();
    const admission = recorder.getAdmissionReceipt();
    assert(admission, "expected running turn admission");
    const steer = createUserTurnTranscriptRecorder({
      target,
      input: { text: "Include the correction" },
      updateMode: "none",
    });
    await steer.persistApproved();
    await steer.confirmSteerTargetRunIdForPersistence?.("running-turn");
    const terminal = await appendTranscriptMessage(target, {
      message: { role: "assistant", content: "Corrected answer" },
    });
    assert(terminal?.anchor, "expected terminal transcript anchor");
    const facts = createTurnFacts({ admission, terminal: terminal.anchor }, target);
    const warn = vi.fn();
    await finalizeAcceptedContextEngineTurn({ facts, lease, warn });
    await drainPendingContextEngineTurnsBeforeRun({
      admission: undefined,
      recorder,
      lease,
      sessionTarget: target,
      warn,
    });

    expect(warn).not.toHaveBeenCalled();
    expect(commitTurn).toHaveBeenCalledOnce();
    expect(commitTurn.mock.calls[0]?.[0].messages).toEqual([
      expect.objectContaining({ role: "user", content: "Start the answer" }),
      expect.objectContaining({
        role: "user",
        content: "Include the correction",
        __openclaw: expect.objectContaining({ steerTargetRunId: "running-turn" }),
      }),
      expect.objectContaining({ role: "assistant", content: "Corrected answer" }),
    ]);
  });

  it("commits the accepted session first and preserves bounded retries for other sessions", async () => {
    const { database, facts, enqueue, commitTurn, finalize } = await createAcceptedTurnFixture();
    database.db
      .prepare("DELETE FROM context_engine_turn_outbox WHERE advancement_key = ?")
      .run(facts.boundary.admission.logicalTurnId);
    for (let index = 0; index < 16; index += 1) {
      const sessionId = `orphaned-admission-${index}`;
      enqueue({
        ...facts.boundary.admission,
        logicalTurnId: sessionId,
        sessionId,
        sessionKey: `agent:main:${sessionId}`,
      });
    }
    const retrySessionId = "retry-ready";
    enqueueContextEngineTurnCommit({
      database,
      engineId: "test",
      payload: {
        boundary: createTurnBoundary(database.path, retrySessionId, retrySessionId),
        messages: [],
      },
    });
    enqueue();

    await finalize();

    expect(commitTurn.mock.calls.map(([turn]) => turn.sessionId)).toEqual([
      facts.sessionIdUsed,
      retrySessionId,
    ]);
  });

  it.each([null, "missing", "metadata-0", "metadata-1", "terminal"])(
    "preserves the depth boundary for a broken ancestry ending at %s",
    async (parent) => {
      const { database, facts, readRange } = await createAcceptedTurnFixture({
        metadataCount: 2,
      });
      database.db
        .prepare(
          "UPDATE transcript_event_identities SET parent_id = ? WHERE session_id = ? AND event_id = ?",
        )
        .run(
          parent === "terminal" ? facts.boundary.terminal.entryId : parent,
          facts.sessionIdUsed,
          "metadata-0",
        );
      expect(readRange(2)).toEqual({ kind: "too-large" });
      expect(readRange(3)).toEqual({ kind: "non-descendant" });
    },
  );

  it("bounds ancestry reads while preserving the accepted range and depth limit", async () => {
    const { database, readRange, commitTurn, finalize } = await createAcceptedTurnFixture({
      metadataCount: 64,
    });
    const reads = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["freshness", "read"],
      (sql) =>
        /^PRAGMA data_version$|FROM main\.pragma_data_version\(\)\s*$/iu.test(sql)
          ? "freshness"
          : /^\s*(?:select|with)\b/i.test(sql)
            ? "read"
            : null,
    );
    try {
      expect(readRange(65)).toMatchObject({
        kind: "ok",
        messages: acceptedMessages,
      });
      expect(reads.counts.freshness).toBe(0);
      expect(reads.counts.read).toBeLessThanOrEqual(8);
    } finally {
      reads.restore();
    }
    expect(readRange(64)).toEqual({ kind: "too-large" });
    await finalize();
    expect(commitTurn.mock.calls[0]?.[0]).toMatchObject({
      messages: acceptedMessages,
    });
  });

  it.each([false, true])("requires complete durable ownership (declared=%s)", async (declared) => {
    const facts = createTurnFacts(
      createTurnBoundary("sqlite://accepted-turn", "logical-turn", "accepted-turn"),
    );
    const { lease, warn } = createDurableLease();
    delete lease.engine.commitTurn;
    if (!declared) {
      delete lease.engine.info.transcriptSemantics;
    }
    await finalizeAcceptedContextEngineTurn({ facts, lease, warn });
    if (declared) {
      expect(warn).toHaveBeenCalledWith(
        "[context-engine] skipped accepted turn advancement: accepted context engine does not support durable turn advancement",
      );
    } else {
      expect(warn).not.toHaveBeenCalled();
    }
  });

  it("advances only the admitted durable range and rejects stale admission facts", async () => {
    const turn = await createAcceptedTurnFixture({ prefix: ["prior"] });
    const { admission, database, facts, target, priorId } = turn;
    const { readPayload, enqueue, commitTurn, warn } = turn;
    const terminal = facts.boundary.terminal;
    const baseFacts = {
      ...facts,
      runtimeContext: {
        provider: "test",
        modelId: "model",
        modelContextWindow: 200_000,
        tokenBudget: 180_000,
      },
    };

    await turn.finalize({ facts: baseFacts });

    expect(commitTurn).toHaveBeenCalledOnce();
    expect(commitTurn.mock.calls[0]?.[0]).toMatchObject({
      runtimeContext: baseFacts.runtimeContext,
      messages: acceptedMessages,
    });
    expect(commitTurn.mock.calls[0]?.[0]).not.toHaveProperty("prePromptMessageCount");

    await turn.finalize({
      facts: {
        ...baseFacts,
        boundary: {
          ...baseFacts.boundary,
          admission: { ...admission, rawSeq: admission.rawSeq + 1 },
        },
      },
    });

    expect(commitTurn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[context-engine] skipped accepted turn advancement: accepted context-engine transcript range is stale",
    );
    expect(readPayload()).toMatchObject({ state: "blocked", failure: "stale" });

    await turn.drain({ ...admission, logicalTurnId: "logical-turn-next" });
    expect(turn.lease.degradeBeforeStart).not.toHaveBeenCalled();

    const sibling = await appendTurnMessage(target, "assistant", "sibling", 4_000, priorId);
    assert(sibling, "expected sibling transcript");
    const siblingIdentity = database.db
      .prepare("SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?")
      .get(target.sessionId, sibling.messageId) as { seq?: number } | undefined;
    assert(siblingIdentity?.seq !== undefined, "expected sibling transcript identity");
    // Model a stale/concurrent projection that assigns a later active position
    // to a sibling. Position order alone must not make it an accepted descendant.
    database.db
      .prepare(
        "INSERT INTO session_transcript_active_events (session_id, active_position, event_seq, message_position, context_eligible) VALUES (?, ?, ?, ?, 1)",
      )
      .run(
        target.sessionId,
        terminal.activeMessagePosition + 1,
        siblingIdentity.seq,
        terminal.activeMessagePosition + 1,
      );
    database.db
      .prepare(
        "UPDATE session_transcript_index_state SET indexed_seq = ?, needs_rebuild = 0 WHERE session_id = ?",
      )
      .run(siblingIdentity.seq, target.sessionId);
    const siblingAnchor = readActiveTranscriptEntryAnchor({
      ...target,
      entryId: sibling.messageId,
    });
    assert(siblingAnchor, "expected projected sibling transcript anchor");
    const siblingAdmission = { ...admission, logicalTurnId: "logical-turn-2" };
    enqueue(siblingAdmission);
    warn.mockClear();
    await turn.finalize({
      facts: {
        ...baseFacts,
        boundary: { admission: siblingAdmission, terminal: siblingAnchor },
      },
    });

    expect(commitTurn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[context-engine] skipped accepted turn advancement: accepted context-engine transcript range is non-descendant",
    );
    expect(readPayload(siblingAdmission.logicalTurnId)).toMatchObject({
      state: "blocked",
      failure: "non-descendant",
    });
  });

  it.each([
    { name: "physical session", change: { sessionIdUsed: "other-session" } },
    { name: "caller key", change: { sessionKey: "other-key" } },
    { name: "target agent", change: { sessionTarget: { agentId: "other-agent" } } },
    { name: "target session", change: { sessionTarget: { sessionId: "other-session" } } },
    { name: "target key", change: { sessionTarget: { sessionKey: "other-key" } } },
    { name: "terminal session", terminal: { sessionId: "other-session" } },
    { name: "terminal key", terminal: { sessionKey: "other-key" } },
    { name: "terminal agent", terminal: { agentId: "other-agent" } },
    { name: "terminal store", terminal: { storePath: "other-store" } },
  ])("does not commit a candidate with mismatched $name", async ({ change, terminal }) => {
    const { facts, commitTurn, finalize, warn } = await createAcceptedTurnFixture();
    await finalize({
      facts: {
        ...facts,
        ...change,
        boundary: { ...facts.boundary, terminal: { ...facts.boundary.terminal, ...terminal } },
      },
    });
    expect(commitTurn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("target changed after admission"));
  });

  it.each(["history", "accepted turn"] as const)(
    "applies the byte cap only to the accepted range, with oversized %s",
    async (oversized) => {
      const { database, readRow, readPayload, commitTurn, finalize, warn } =
        await createAcceptedTurnFixture({
          answer:
            oversized === "accepted turn" ? `answer ${"x".repeat(9 * 1024 * 1024)}` : "answer",
          prefix:
            oversized === "history"
              ? [0, 1, 2].map((index) => `prefix-${index} ${"x".repeat(3 * 1024 * 1024)}`)
              : ["prior"],
        });
      const hostOutboxSql = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(database.db),
        ["outbox"],
        (sql) => (sql.includes("context_engine_turn_outbox") ? "outbox" : null),
      );
      try {
        await finalize();
      } finally {
        hostOutboxSql.restore();
      }
      expect(hostOutboxSql.counts.outbox).toBe(0);
      if (oversized === "history") {
        expect(warn).not.toHaveBeenCalled();
        expect(commitTurn).toHaveBeenCalledOnce();
        expect(readRow()).toBeUndefined();
      } else {
        expect(commitTurn).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(
          "[context-engine] skipped accepted turn advancement: accepted context-engine transcript range is too-large",
        );
        expect(readPayload()).toMatchObject({ state: "blocked", failure: "too-large" });
      }
    },
  );

  it.each(["finalization", "commit recovery", "publication recovery"] as const)(
    "queues %s behind an in-flight worker write",
    async (operation) => {
      const turn = await createAcceptedTurnFixture();
      const recovery = operation !== "finalization";
      if (operation === "commit recovery") {
        turn.commitTurn.mockRejectedValueOnce(new Error("engine offline"));
        await turn.finalize();
        expect(turn.readPayload()).toMatchObject({ state: "ready" });
      } else if (operation === "publication recovery") {
        // Acceptance must survive a failed publication transaction for the next run to recover.
        const terminal = turn.database.db
          .prepare(
            "SELECT event.seq AS seq, event.event_json AS event_json FROM transcript_events AS event JOIN transcript_event_identities AS identity ON identity.session_id = event.session_id AND identity.seq = event.seq WHERE identity.session_id = ? AND identity.event_id = ?",
          )
          .get(turn.facts.sessionIdUsed, turn.facts.boundary.terminal.entryId) as {
          seq: number;
          event_json: string;
        };
        const setJson = (value: string) =>
          turn.database.db
            .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = ?")
            .run(value, turn.facts.sessionIdUsed, terminal.seq);
        setJson("{");
        try {
          await turn.finalize();
        } finally {
          setJson(terminal.event_json);
        }
        expect(turn.warn).toHaveBeenCalledWith(
          expect.stringContaining("[context-engine] skipped accepted turn advancement:"),
        );
        expect(turn.commitTurn).not.toHaveBeenCalled();
        expect(turn.readPayload()).toMatchObject({ state: "accepted" });
      }
      turn.warn.mockClear();
      const commitsBefore = turn.commitTurn.mock.calls.length;
      const { worker, release: releaseWorker } = await holdWorker(turn.database);
      const submitted = createDeferredCore();
      let writeStarted = false;
      const enqueue = workerWriteAdmission.runOpenClawAgentWorkerWrite;
      const submission = vi
        .spyOn(workerWriteAdmission, "runOpenClawAgentWorkerWrite")
        .mockImplementation(<T>(...args: Parameters<typeof enqueue<T>>) => {
          const [options, run, timing, signal] = args;
          const targetWrite = !("target" in options) && options.path === turn.database.path;
          const result = enqueue(
            options,
            async () => {
              if (targetWrite) {
                writeStarted = true;
              }
              return run();
            },
            timing,
            signal,
          );
          if (targetWrite) {
            submitted.resolve();
          }
          return result;
        });
      const nextAdmission = { ...turn.admission, logicalTurnId: "logical-turn-after-pending" };
      const settling = recovery ? turn.drain(nextAdmission) : turn.finalize();
      try {
        // Opening the worker facade can yield before submission; wait for the real
        // write request, then prove it has not taken effect while the owner is held.
        await submitted.promise;
        expect(writeStarted).toBe(false);
        expect(turn.readPayload()).toMatchObject({
          state:
            operation === "commit recovery"
              ? "ready"
              : operation === "publication recovery"
                ? "accepted"
                : "admitted",
        });
        expect(turn.commitTurn).toHaveBeenCalledTimes(commitsBefore);
      } finally {
        submission.mockRestore();
        releaseWorker.resolve();
        await worker;
        await settling;
      }
      expect(turn.warn).not.toHaveBeenCalled();
      expect(turn.lease.degradeBeforeStart).not.toHaveBeenCalled();
      expect(turn.commitTurn).toHaveBeenCalledTimes(commitsBefore + 1);
      expect(turn.readRow()).toBeUndefined();
      if (recovery) {
        expect(turn.readPayload(nextAdmission.logicalTurnId)).toMatchObject({ state: "admitted" });
      }
      if (operation === "publication recovery") {
        expect(turn.commitTurn.mock.calls[0]?.[0]).toMatchObject({
          advancementKey: turn.admission.logicalTurnId,
          messages: acceptedMessages,
        });
      }
    },
  );

  it.each([{ outcome: "committed" as const }, { outcome: "failed" as const }])(
    "settles a drained row behind a worker write that starts during commitTurn ($outcome)",
    async ({ outcome }) => {
      const { admission, database, readRow, commitTurn, finalize, warn } =
        await createAcceptedTurnFixture();
      let held: Awaited<ReturnType<typeof holdWorker>> | undefined;
      const commitSettling = createDeferredCore();
      commitTurn.mockImplementationOnce(async () => {
        held = await holdWorker(database);
        commitSettling.resolve();
        if (outcome === "failed") {
          throw new Error("engine offline");
        }
        return { status: "committed" };
      });

      const finalizing = finalize();
      await commitSettling.promise;
      // Let the drain reach its settlement write without a timer.
      for (let hop = 0; hop < 20; hop += 1) {
        await Promise.resolve();
      }
      const rowWhileWorkerHeld = readRow();
      const queuedWhileWorkerHeld = [...SQLITE_SESSION_WRITER_QUEUES.values()].reduce(
        (count, queue) => count + queue.pending.length,
        0,
      );
      held?.release.resolve();
      await held?.worker;
      await finalizing;

      expect(JSON.parse(rowWhileWorkerHeld?.payload_json ?? "{}")).toMatchObject({
        state: "ready",
      });
      expect(rowWhileWorkerHeld?.attempt_count).toBe(0);
      expect(queuedWhileWorkerHeld).toBe(1);
      if (outcome === "committed") {
        expect(readRow()).toBeUndefined();
        expect(warn).not.toHaveBeenCalled();
      } else {
        expect(readRow()).toMatchObject({ attempt_count: 1, last_error: "engine offline" });
        expect(warn).toHaveBeenCalledWith(
          `[context-engine] durable turn advancement remains queued: ${admission.logicalTurnId}: engine offline`,
        );
      }
    },
  );
});
