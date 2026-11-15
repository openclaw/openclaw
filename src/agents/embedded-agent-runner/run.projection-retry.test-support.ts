import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAttemptResult, makeCompactionSuccess } from "./run.overflow-compaction.fixture.js";
import {
  createOverflowRunParams,
  mockedCompactDirect,
  mockedRunEmbeddedAttempt,
} from "./run.overflow-compaction.harness.js";
import {
  createFreshRunIntegrationState,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;
let agentDatabase: typeof import("../../state/openclaw-agent-db.js");
let agentDatabaseTest: typeof import("../../state/openclaw-agent-db.test-support.js");
let sessionAccessor: typeof import("../../config/sessions/session-accessor.js");
let activeEvents: typeof import("../../config/sessions/session-accessor.sqlite-active-events.js");
let sqliteScope: typeof import("../../config/sessions/session-accessor.sqlite-scope.js");
let reconcile: typeof import("../../config/sessions/session-transcript-reconcile.js");

describe("runEmbeddedAgent transcript projection retry", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
    agentDatabase = await import("../../state/openclaw-agent-db.js");
    agentDatabaseTest = await import("../../state/openclaw-agent-db.test-support.js");
    sessionAccessor = await import("../../config/sessions/session-accessor.js");
    activeEvents = await import("../../config/sessions/session-accessor.sqlite-active-events.js");
    sqliteScope = await import("../../config/sessions/session-accessor.sqlite-scope.js");
    reconcile = await import("../../config/sessions/session-transcript-reconcile.js");
  });

  beforeEach(async () => {
    state = await createFreshRunIntegrationState("run.projection-retry");
  });

  afterEach(async () => {
    await state?.cleanup();
    expect(
      agentDatabaseTest
        .listOpenClawAgentDatabasesForTest()
        .filter((database) => database.path.startsWith(`${state.stateDir}${path.sep}`)),
    ).toEqual([]);
    await expect(fs.stat(state.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("settles an owned compacted retry before durable reopen while ordinary reads stay fail-fast", async () => {
    const sessionId = "projection-retry-session";
    const sessionKey = "agent:main:projection-retry";
    const storePath = state.statePath("alternate", "sessions.json");
    const sessionTarget = { agentId: "main", sessionId, sessionKey, storePath };
    await sessionAccessor.replaceSessionEntry(sessionTarget, { sessionId, updatedAt: 1 });
    await sessionAccessor.persistSessionTranscriptTurn(sessionTarget, {
      messages: [
        {
          eventId: "seed",
          parentId: null,
          message: { role: "user", content: "seed" },
        },
      ],
      touchSessionEntry: false,
    });
    const databaseOptions = sqliteScope.toDatabaseOptions(
      sqliteScope.resolveSqliteTranscriptReadScope(sessionTarget),
    );
    const readPage = () =>
      activeEvents.readSessionTranscriptMessageEventPage(sessionTarget, {
        maxMessages: 1,
        offset: 0,
      });
    const controller = new AbortController();
    const originalWaitForProjection = reconcile.waitForSessionTranscriptProjection;
    let compactionFinished = false;
    let ownedProjectionSettled = false;
    let ownedProjectionSignal: AbortSignal | undefined;
    const waitForProjection = vi
      .spyOn(reconcile, "waitForSessionTranscriptProjection")
      .mockImplementation(async (scope, abortSignal) => {
        await originalWaitForProjection(scope, abortSignal);
        // The foreground startup barrier cannot settle a later compaction.
        if (!compactionFinished) {
          return;
        }
        ownedProjectionSignal = abortSignal;
        expect(
          agentDatabase
            .openOpenClawAgentDatabase(databaseOptions)
            .db.prepare(
              "SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?",
            )
            .get(sessionId),
        ).toEqual({ needs_rebuild: 0 });
        ownedProjectionSettled = true;
      });

    try {
      mockedRunEmbeddedAttempt
        .mockResolvedValueOnce(
          makeAttemptResult({
            timedOut: true,
            sessionIdUsed: sessionId,
            lastAssistant: { usage: { input: 160_000 } } as never,
          }),
        )
        .mockImplementationOnce(async () => {
          expect(ownedProjectionSettled).toBe(true);
          expect(readPage().totalMessages).toBe(1);
          return makeAttemptResult({ sessionIdUsed: sessionId });
        });
      mockedCompactDirect.mockImplementationOnce(async () => {
        expect(ownedProjectionSettled).toBe(false);
        const database = agentDatabase.openOpenClawAgentDatabase(databaseOptions);
        database.db
          .prepare(
            "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
          )
          .run(sessionId);

        expect(readPage).toThrow(activeEvents.SessionTranscriptProjectionUnavailableError);
        reconcile.startSessionTranscriptIndexReconcile({
          ...databaseOptions,
          preferredSessionId: sessionId,
        });
        compactionFinished = true;
        return makeCompactionSuccess({
          summary: "compacted before projection retry",
          tokensBefore: 160_000,
          tokensAfter: 60_000,
        });
      });

      await runEmbeddedAgent({
        ...createOverflowRunParams(state),
        runId: "run-owned-projection-retry",
        sessionId,
        sessionKey,
        sessionFile: sessionKey,
        sessionTarget,
        abortSignal: controller.signal,
      });

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
      expect(waitForProjection).toHaveBeenCalledWith(
        { ...sessionTarget, expectedWriterRunId: "run-owned-projection-retry" },
        expect.any(AbortSignal),
      );
      await agentDatabase.closeOpenClawAgentDatabaseByPathAsync(
        agentDatabase.resolveOpenClawAgentSqlitePath(databaseOptions),
      );
      expect(readPage().totalMessages).toBe(1);
      const cancellation = new Error("caller stopped projection work");
      controller.abort(cancellation);
      expect(ownedProjectionSignal?.reason).toBe(cancellation);
    } finally {
      waitForProjection.mockRestore();
      await reconcile.waitForSessionTranscriptIndexReconcile(databaseOptions);
    }
  });
});
