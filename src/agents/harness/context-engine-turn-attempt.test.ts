import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
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
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import type { ContextEngineLogicalTurnLease } from "./context-engine-logical-turn.js";
import {
  drainPendingContextEngineTurnsBeforeRun,
  finalizeAcceptedContextEngineTurn,
  type ContextEngineTurnAttemptFacts,
} from "./context-engine-turn-attempt.js";
import {
  enqueueContextEngineTurnCommit,
  enqueueContextEngineTurnIntent,
} from "./context-engine-turn-outbox.kernel.worker.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-context-turn-range-");

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
  const engine: ContextEngine = {
    info: {
      id: "test",
      name: "Test",
      transcriptSemantics: {
        currentTurnFence: "before-current-turn-entry-v1",
        turnAdvancementIdempotency: "atomic-idempotent-v1",
      },
    },
    ingest: async () => ({ ingested: true }),
    assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
    compact: async () => ({ ok: true, compacted: false }),
    commitTurn,
  };
  const lease = {
    engine,
    effectiveEngine: engine,
    effectiveEngineId: "test",
    effectiveEnginePluginId: undefined,
    degraded: false,
    disposed: false,
    degradedReason: undefined,
    selectForHost: vi.fn(),
    degradeBeforeStart: vi.fn(),
    begin: vi.fn(),
    onDispose: vi.fn(),
    deferDisposalUntil: () => undefined,
    dispose: async () => undefined,
  } satisfies ContextEngineLogicalTurnLease;
  return { commitTurn, lease };
}

async function createAcceptedTurnFixture(
  params: {
    answer?: string;
    logicalTurnId?: string;
    metadataCount?: number;
    prefix?: string[];
    sessionId?: string;
  } = {},
) {
  const sessionId = params.sessionId ?? "accepted-turn";
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
  const admitted = await appendTranscriptMessage(target, {
    message: { role: "user", content: "current" },
    parentId,
    now: 10_000,
  });
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
  const terminal = await appendTranscriptMessage(target, {
    message: { role: "assistant", content: params.answer ?? "answer" },
    parentId,
    now: 11_000,
  });
  if (!admitted?.anchor || !terminal?.anchor) {
    throw new Error("expected admitted turn transcript");
  }
  const admission = {
    ...admitted.anchor,
    logicalTurnId: params.logicalTurnId ?? "logical-turn",
    role: "user" as const,
  };
  const database = openOpenClawAgentDatabase({
    agentId: target.agentId,
    path: admission.storePath,
  });
  enqueueContextEngineTurnIntent({
    admission,
    database,
    engineId: "test",
  });
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
  return {
    admission,
    database,
    target,
    priorId,
    readRow,
    readPayload,
    facts: {
      boundary: { admission, terminal: terminal.anchor },
      sessionIdUsed: target.sessionId,
      sessionKey: target.sessionKey,
      sessionTarget: target,
      promptError: false,
      aborted: false,
      yieldAborted: false,
    } satisfies ContextEngineTurnAttemptFacts,
  };
}

describe("accepted context-engine turn finalization", () => {
  it("commits a running turn once after confirming a persisted steer", async () => {
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
    if (!admission) {
      throw new Error("expected running turn admission");
    }
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
    if (!terminal?.anchor) {
      throw new Error("expected terminal transcript anchor");
    }
    const facts: ContextEngineTurnAttemptFacts = {
      boundary: { admission, terminal: terminal.anchor },
      sessionIdUsed: target.sessionId,
      sessionKey: target.sessionKey,
      sessionTarget: target,
      promptError: false,
      aborted: false,
      yieldAborted: false,
    };
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
    const { database, facts } = await createAcceptedTurnFixture({
      answer: "answer",
      logicalTurnId: "accepted-after-orphans",
      prefix: [],
      sessionId: "accepted-after-orphans",
    });
    database.db
      .prepare("DELETE FROM context_engine_turn_outbox WHERE advancement_key = ?")
      .run(facts.boundary.admission.logicalTurnId);
    const retrySessionId = "retry-ready";
    enqueueContextEngineTurnCommit({
      database,
      engineId: "test",
      payload: {
        boundary: {
          admission: {
            ...facts.boundary.admission,
            logicalTurnId: retrySessionId,
            sessionId: retrySessionId,
            sessionKey: `agent:main:${retrySessionId}`,
          },
          terminal: {
            ...facts.boundary.terminal,
            sessionId: retrySessionId,
            sessionKey: `agent:main:${retrySessionId}`,
          },
        },
        messages: [],
      },
    });
    for (let index = 0; index < 15; index += 1) {
      const sessionId = `orphaned-admission-${index}`;
      enqueueContextEngineTurnIntent({
        admission: {
          ...facts.boundary.admission,
          logicalTurnId: sessionId,
          sessionId,
          sessionKey: `agent:main:${sessionId}`,
        },
        database,
        engineId: "test",
      });
    }
    enqueueContextEngineTurnIntent({
      admission: facts.boundary.admission,
      database,
      engineId: "test",
    });
    const { commitTurn, lease } = createDurableLease();

    await finalizeAcceptedContextEngineTurn({ facts, lease });

    expect(commitTurn.mock.calls.map(([turn]) => turn.sessionId)).toEqual([
      facts.sessionIdUsed,
      retrySessionId,
    ]);
  });

  it.each([null, "missing", "metadata-0", "metadata-1", "terminal"])(
    "preserves the depth boundary for a broken ancestry ending at %s",
    async (parent) => {
      const { database, facts } = await createAcceptedTurnFixture({
        answer: "answer",
        logicalTurnId: "broken-metadata-turn",
        metadataCount: 2,
        prefix: [],
        sessionId: "broken-metadata-turn",
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
      expect(
        readClosedTranscriptTurnInDatabase(database.db, {
          boundary: facts.boundary,
          maxEvents: 2,
          maxBytes: 1024,
        }),
      ).toEqual({ kind: "too-large" });
      expect(
        readClosedTranscriptTurnInDatabase(database.db, {
          boundary: facts.boundary,
          maxEvents: 3,
          maxBytes: 1024,
        }),
      ).toEqual({ kind: "non-descendant" });
    },
  );

  it("bounds ancestry reads while preserving the accepted range and depth limit", async () => {
    const { database, facts } = await createAcceptedTurnFixture({
      answer: "answer",
      logicalTurnId: "metadata-turn",
      metadataCount: 64,
      prefix: [],
      sessionId: "metadata-turn",
    });
    const reads = trackSqliteStatementExecutions(database.db, ["freshness", "read"], (sql) =>
      /^PRAGMA data_version$|FROM main\.pragma_data_version\(\)\s*$/iu.test(sql)
        ? "freshness"
        : /^\s*(?:select|with)\b/i.test(sql)
          ? "read"
          : null,
    );
    try {
      expect(
        readClosedTranscriptTurnInDatabase(database.db, {
          boundary: facts.boundary,
          maxEvents: 65,
          maxBytes: 1024,
        }),
      ).toMatchObject({
        kind: "ok",
        messages: [
          { role: "user", content: "current" },
          { role: "assistant", content: "answer" },
        ],
      });
      expect(reads.counts.freshness).toBe(0);
      expect(reads.counts.read).toBeLessThanOrEqual(8);
    } finally {
      reads.restore();
    }
    expect(
      readClosedTranscriptTurnInDatabase(database.db, {
        boundary: facts.boundary,
        maxEvents: 64,
        maxBytes: 1024,
      }),
    ).toEqual({ kind: "too-large" });
    const { commitTurn, lease } = createDurableLease();
    await finalizeAcceptedContextEngineTurn({ facts, lease });
    expect(commitTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({ role: "user", content: "current" }),
          expect.objectContaining({ role: "assistant", content: "answer" }),
        ],
      }),
    );
  });

  it("silently skips engines without durable turn ownership but rejects partial declarations", async () => {
    const admission = {
      agentId: "main",
      sessionId: "accepted-turn",
      sessionKey: "agent:main:accepted-turn",
      storePath: "sqlite://accepted-turn",
      generation: "generation",
      entryId: "user-entry",
      rawSeq: 1,
      effectiveParentId: null,
      activeMessagePosition: 0,
      logicalTurnId: "logical-turn",
      role: "user" as const,
    };
    const facts = {
      boundary: {
        admission,
        terminal: {
          ...admission,
          entryId: "assistant-entry",
          rawSeq: 2,
          activeMessagePosition: 1,
        },
      },
      sessionIdUsed: admission.sessionId,
      sessionKey: admission.sessionKey,
      promptError: false,
      aborted: false,
      yieldAborted: false,
    } satisfies ContextEngineTurnAttemptFacts;
    const makeLease = (declaresDurableAdvancement: boolean) => {
      const { lease } = createDurableLease();
      delete lease.engine.commitTurn;
      if (!declaresDurableAdvancement) {
        delete lease.engine.info.transcriptSemantics;
      }
      return lease;
    };
    const warn = vi.fn();

    await finalizeAcceptedContextEngineTurn({
      facts,
      lease: makeLease(false),
      warn,
    });

    expect(warn).not.toHaveBeenCalled();

    await finalizeAcceptedContextEngineTurn({
      facts,
      lease: makeLease(true),
      warn,
    });

    expect(warn).toHaveBeenCalledWith(
      "[context-engine] skipped accepted turn advancement: accepted context engine does not support durable turn advancement",
    );
  });

  it("advances only the admitted durable range and rejects stale admission facts", async () => {
    const { admission, database, facts, target, priorId, readPayload } =
      await createAcceptedTurnFixture({ prefix: ["prior"] });
    const terminal = facts.boundary.terminal;
    expect(
      readClosedTranscriptTurnInDatabase(database.db, {
        boundary: facts.boundary,
        maxEvents: 2,
        maxBytes: 1024,
      }),
    ).toMatchObject({
      kind: "ok",
      messages: [
        { role: "user", content: "current" },
        { role: "assistant", content: "answer" },
      ],
    });
    const { commitTurn, lease } = createDurableLease();
    const baseFacts = {
      ...facts,
      runtimeContext: {
        provider: "test",
        modelId: "model",
        modelContextWindow: 200_000,
        tokenBudget: 180_000,
      },
    };

    await finalizeAcceptedContextEngineTurn({ facts: baseFacts, lease });

    expect(commitTurn).toHaveBeenCalledOnce();
    expect(commitTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeContext: baseFacts.runtimeContext,
        messages: [
          expect.objectContaining({ role: "user", content: "current" }),
          expect.objectContaining({ role: "assistant", content: "answer" }),
        ],
      }),
    );
    expect(commitTurn.mock.calls[0]?.[0]).not.toHaveProperty("prePromptMessageCount");

    const warn = vi.fn();
    await finalizeAcceptedContextEngineTurn({
      facts: {
        ...baseFacts,
        boundary: {
          ...baseFacts.boundary,
          admission: { ...admission, rawSeq: admission.rawSeq + 1 },
        },
      },
      lease,
      warn,
    });

    expect(commitTurn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[context-engine] skipped accepted turn advancement: accepted context-engine transcript range is stale",
    );
    expect(readPayload()).toMatchObject({ state: "blocked", failure: "stale" });

    const nextAdmission = {
      ...admission,
      logicalTurnId: "logical-turn-next",
    };
    await drainPendingContextEngineTurnsBeforeRun({
      admission: nextAdmission,
      lease,
      warn,
    });
    expect(lease.degradeBeforeStart).not.toHaveBeenCalled();

    const sibling = await appendTranscriptMessage(target, {
      message: { role: "assistant", content: "sibling" },
      parentId: priorId,
      now: 4_000,
    });
    if (!sibling) {
      throw new Error("expected sibling transcript");
    }
    const siblingIdentity = database.db
      .prepare("SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?")
      .get(target.sessionId, sibling.messageId) as { seq?: number } | undefined;
    if (siblingIdentity?.seq === undefined) {
      throw new Error("expected sibling transcript identity");
    }
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
    if (!siblingAnchor) {
      throw new Error("expected projected sibling transcript anchor");
    }
    const siblingAdmission = {
      ...admission,
      logicalTurnId: "logical-turn-2",
    };
    enqueueContextEngineTurnIntent({
      admission: siblingAdmission,
      database,
      engineId: "test",
    });
    warn.mockClear();
    await finalizeAcceptedContextEngineTurn({
      facts: {
        ...baseFacts,
        boundary: { admission: siblingAdmission, terminal: siblingAnchor },
      },
      lease,
      warn,
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
    const { facts } = await createAcceptedTurnFixture({
      answer: "answer",
      logicalTurnId: "mismatched-turn",
      prefix: [],
      sessionId: "physical-session",
    });
    const { commitTurn, lease } = createDurableLease();
    const warn = vi.fn();
    await finalizeAcceptedContextEngineTurn({
      facts: {
        ...facts,
        ...change,
        boundary: { ...facts.boundary, terminal: { ...facts.boundary.terminal, ...terminal } },
      },
      lease,
      warn,
    });
    expect(commitTurn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("target changed after admission"));
  });

  it.each(["history", "accepted turn"] as const)(
    "applies the byte cap only to the accepted range, with oversized %s",
    async (oversized) => {
      const { database, facts, readRow, readPayload } = await createAcceptedTurnFixture({
        answer: oversized === "accepted turn" ? `answer ${"x".repeat(9 * 1024 * 1024)}` : "answer",
        prefix:
          oversized === "history"
            ? [0, 1, 2].map((index) => `prefix-${index} ${"x".repeat(3 * 1024 * 1024)}`)
            : ["prior"],
      });
      const { commitTurn, lease } = createDurableLease();
      const warn = vi.fn();
      const hostOutboxSql = trackSqliteStatementExecutions(database.db, ["outbox"], (sql) =>
        sql.includes("context_engine_turn_outbox") ? "outbox" : null,
      );
      try {
        await finalizeAcceptedContextEngineTurn({ facts, lease, warn });
      } finally {
        hostOutboxSql.restore();
      }
      expect(hostOutboxSql.counts.outbox).toBe(0);
      if (oversized === "history") {
        expect(warn).not.toHaveBeenCalled();
        expect(commitTurn).toHaveBeenCalledOnce();
        expect(commitTurn.mock.calls[0]?.[0].messages).toEqual([
          expect.objectContaining({ role: "user", content: "current" }),
          expect.objectContaining({ role: "assistant", content: "answer" }),
        ]);
        expect(commitTurn.mock.calls[0]?.[0]).not.toHaveProperty("prePromptMessageCount");
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
      const { admission, database, facts, readPayload, readRow } =
        await createAcceptedTurnFixture();
      const { commitTurn, lease } = createDurableLease();
      const warn = vi.fn();
      const recovery = operation !== "finalization";
      if (operation === "commit recovery") {
        commitTurn.mockRejectedValueOnce(new Error("engine offline"));
        await finalizeAcceptedContextEngineTurn({ facts, lease, warn });
        expect(readPayload()).toMatchObject({ state: "ready" });
      } else if (operation === "publication recovery") {
        // Acceptance must survive a failed publication transaction for the next run to recover.
        const terminal = database.db
          .prepare(
            "SELECT event.seq AS seq, event.event_json AS event_json FROM transcript_events AS event JOIN transcript_event_identities AS identity ON identity.session_id = event.session_id AND identity.seq = event.seq WHERE identity.session_id = ? AND identity.event_id = ?",
          )
          .get(facts.sessionIdUsed, facts.boundary.terminal.entryId) as {
          seq: number;
          event_json: string;
        };
        const setJson = (value: string) =>
          database.db
            .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = ?")
            .run(value, facts.sessionIdUsed, terminal.seq);
        setJson("{");
        try {
          await finalizeAcceptedContextEngineTurn({ facts, lease, warn });
        } finally {
          setJson(terminal.event_json);
        }
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("[context-engine] skipped accepted turn advancement:"),
        );
        expect(commitTurn).not.toHaveBeenCalled();
        expect(readPayload()).toMatchObject({ state: "accepted" });
      }
      warn.mockClear();
      const commitsBefore = commitTurn.mock.calls.length;
      const admitted = createDeferredCore();
      const releaseWorker = createDeferredCore();
      const worker = workerWriteAdmission.runOpenClawAgentWorkerWrite(
        { agentId: database.agentId, path: database.path },
        async () => {
          admitted.resolve();
          await releaseWorker.promise;
        },
      );
      await admitted.promise;
      const submitted = createDeferredCore();
      let writeStarted = false;
      const enqueue = workerWriteAdmission.runOpenClawAgentWorkerWrite;
      const submission = vi
        .spyOn(workerWriteAdmission, "runOpenClawAgentWorkerWrite")
        .mockImplementation(<T>(...args: Parameters<typeof enqueue<T>>) => {
          const [options, run, timing, signal] = args;
          const targetWrite = !("target" in options) && options.path === database.path;
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
      const nextAdmission = { ...admission, logicalTurnId: "logical-turn-after-pending" };
      const settling = recovery
        ? drainPendingContextEngineTurnsBeforeRun({ admission: nextAdmission, lease, warn })
        : finalizeAcceptedContextEngineTurn({ facts, lease, warn });
      try {
        // Opening the worker facade can yield before submission; wait for the real
        // write request, then prove it has not taken effect while the owner is held.
        await submitted.promise;
        expect(writeStarted).toBe(false);
        expect(readPayload()).toMatchObject({
          state:
            operation === "commit recovery"
              ? "ready"
              : operation === "publication recovery"
                ? "accepted"
                : "admitted",
        });
        expect(commitTurn).toHaveBeenCalledTimes(commitsBefore);
      } finally {
        submission.mockRestore();
        releaseWorker.resolve();
        await worker;
        await settling;
      }
      expect(warn).not.toHaveBeenCalled();
      expect(lease.degradeBeforeStart).not.toHaveBeenCalled();
      expect(commitTurn).toHaveBeenCalledTimes(commitsBefore + 1);
      expect(readRow()).toBeUndefined();
      if (recovery) {
        expect(readPayload(nextAdmission.logicalTurnId)).toMatchObject({ state: "admitted" });
      }
      if (operation === "publication recovery") {
        expect(commitTurn.mock.calls[0]?.[0]).toMatchObject({
          advancementKey: admission.logicalTurnId,
          messages: [
            expect.objectContaining({ role: "user", content: "current" }),
            expect.objectContaining({ role: "assistant", content: "answer" }),
          ],
        });
      }
    },
  );

  it.each([{ outcome: "committed" as const }, { outcome: "failed" as const }])(
    "settles a drained row behind a worker write that starts during commitTurn ($outcome)",
    async ({ outcome }) => {
      const { admission, database, facts } = await createAcceptedTurnFixture({
        answer: "answer",
        logicalTurnId: `logical-turn-during-commit-${outcome}`,
        prefix: [],
        sessionId: `during-commit-${outcome}`,
      });
      const { commitTurn, lease } = createDurableLease();
      const warn = vi.fn();
      const readRow = () =>
        database.db
          .prepare(
            "SELECT payload_json, attempt_count, last_error FROM context_engine_turn_outbox WHERE advancement_key = ?",
          )
          .get(admission.logicalTurnId) as
          | { payload_json: string; attempt_count: number; last_error: string | null }
          | undefined;
      let releaseWorker!: () => void;
      let worker: Promise<void> | undefined;
      let commitReturning!: () => void;
      const commitSettling = new Promise<void>((resolve) => {
        commitReturning = resolve;
      });
      commitTurn.mockImplementationOnce(async () => {
        let workerAdmitted!: () => void;
        const admitted = new Promise<void>((resolve) => {
          workerAdmitted = resolve;
        });
        worker = workerWriteAdmission.runOpenClawAgentWorkerWrite(
          { agentId: database.agentId, path: database.path },
          async () => {
            workerAdmitted();
            await new Promise<void>((resolve) => {
              releaseWorker = resolve;
            });
          },
        );
        await admitted;
        commitReturning();
        if (outcome === "failed") {
          throw new Error("engine offline");
        }
        return { status: "committed" };
      });

      const finalizing = finalizeAcceptedContextEngineTurn({ facts, lease, warn });
      await commitSettling;
      // Let the drain reach its settlement write without a timer.
      for (let hop = 0; hop < 20; hop += 1) {
        await Promise.resolve();
      }
      const rowWhileWorkerHeld = readRow();
      const queuedWhileWorkerHeld = [...SQLITE_SESSION_WRITER_QUEUES.values()].reduce(
        (count, queue) => count + queue.pending.length,
        0,
      );
      releaseWorker();
      await worker;
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
