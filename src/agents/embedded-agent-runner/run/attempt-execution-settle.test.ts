import { DatabaseSync, StatementSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptEvent,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import { appendTranscriptEventSnapshotSync } from "../../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { sessionTranscriptIndexNeedsReconcile } from "../../../config/sessions/session-transcript-index.js";
import { waitForSessionTranscriptProjection } from "../../../config/sessions/session-transcript-reconcile.js";
import { resolveSessionTranscriptActiveLeafEntryId } from "../../../config/sessions/transcript-tree.js";
import { selectVisibleTranscriptEvents } from "../../../config/sessions/transcript-visible-events.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import * as workerStore from "../../../infra/sqlite-worker-store.js";
import type {
  SqliteWorkerOperations,
  SqliteWorkerStore,
} from "../../../infra/sqlite-worker-store.js";
import { createNestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import { runWithModelFallback } from "../../model-fallback-runner.js";
import { isRecordedModelFallbackStop } from "../../model-fallback-stop.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { createUsageAccumulator } from "../usage-accumulator.js";

const mocks = vi.hoisted(() => ({
  clearActiveEmbeddedRun: vi.fn(),
  completeAfterTurn: vi.fn(),
  completeResult: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  markRequesterTurnYielded: vi.fn(() => 1),
  settleRequesterAfterSessionSpawns: vi.fn(),
  settleStream: vi.fn(),
  runPrompt: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  log: { debug: mocks.logDebug, error: mocks.logError, warn: mocks.logWarn },
}));
vi.mock("../../subagents/registry/subagent-registry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../subagents/registry/subagent-registry.js")>();
  return {
    ...actual,
    markRequesterTurnYielded: mocks.markRequesterTurnYielded,
    settleRequesterAfterSessionSpawns: mocks.settleRequesterAfterSessionSpawns,
  };
});
vi.mock("../runs.js", () => ({ clearActiveEmbeddedRun: mocks.clearActiveEmbeddedRun }));
vi.mock("./attempt-prompt-phase.js", () => ({
  runEmbeddedAttemptPromptPhase: mocks.runPrompt,
}));
vi.mock("./attempt-result.js", () => ({
  completeEmbeddedAttemptResult: mocks.completeResult,
}));
vi.mock("./attempt-finalize.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./attempt-finalize.js")>();
  return {
    ...actual,
    completeEmbeddedAttemptAfterTurn: mocks.completeAfterTurn,
  };
});
vi.mock("./attempt-stream-settle.js", () => ({
  settleEmbeddedAttemptStream: mocks.settleStream,
}));

import {
  createFixture,
  createPersistedImageNoteFixture,
} from "./attempt-execution-settle.test-support.js";
import { runEmbeddedAttemptSettledPhase } from "./attempt-settle.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.completeResult.mockReset();
});

describe("runEmbeddedAttemptSettledPhase", () => {
  it("runs prompt and finalization, cleans stream resources, then projects the result", async () => {
    const fixture = createFixture(mocks);

    const result = await runEmbeddedAttemptSettledPhase(fixture.input);

    expect(result).toBe(fixture.result);
    expect(fixture.order).toEqual([
      "prompt",
      "finalize",
      "clear-timers",
      "unsubscribe",
      "detach-backend",
      "clear-active-run",
      "result",
    ]);
    expect(fixture.state).toEqual(
      expect.objectContaining({
        beforeAgentRunBlockedBy: "before_agent",
        terminal: { kind: "ok" },
        trajectoryEndRecorded: true,
      }),
    );
    expect(fixture.sessionRuntimeState).toEqual(
      expect.objectContaining({
        prePromptMessageCount: 4,
        promptCache: { cacheRead: 1 },
      }),
    );
    expect(mocks.completeAfterTurn).toHaveBeenCalledWith(
      fixture.input,
      expect.objectContaining({ sessionIdUsed: "settled-session" }),
      expect.objectContaining({ transcriptLeafId: "before-prompt" }),
    );
    expect(mocks.completeResult).toHaveBeenCalledWith(
      fixture.input,
      expect.objectContaining({ sessionIdUsed: "settled-session" }),
      expect.objectContaining({
        beforeAgentFinalizeRevisionReason: "revision",
        sessionIdUsed: "settled-session",
        sessionFileUsed: "/tmp/session.jsonl",
      }),
    );
    expect(fixture.detachBackend).toHaveBeenCalledWith(fixture.queueHandle);
    expect(mocks.clearActiveEmbeddedRun).toHaveBeenCalledWith(
      "session-1",
      fixture.queueHandle,
      "agent:main",
      "/tmp/session.jsonl",
    );
  });

  it("persists image failure notes after after-turn transcript reconciliation", async () => {
    const fixture = createFixture(mocks);
    fixture.sessionRuntimeState.currentTurnImageFailureCount = 1;
    await runEmbeddedAttemptSettledPhase(fixture.input);

    expect(fixture.sessionManager.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "openclaw.system-note",
        display: true,
        content: expect.stringMatching(/1.*image contents.*unavailable.*resend.*not claim/is),
      }),
    );
    expect(fixture.sessionManager.appendMessage.mock.calls[0]?.[0]).not.toHaveProperty(
      "excludeFromContext",
    );
    expect(mocks.completeResult).toHaveBeenCalledWith(
      fixture.input,
      expect.any(Object),
      expect.objectContaining({
        messagesSnapshot: expect.arrayContaining([
          expect.objectContaining({ customType: "openclaw.system-note", display: true }),
        ]),
      }),
    );
  });

  it("persists and publishes image failure notes through settlement without parent SQL", async () => {
    await withOpenClawTestState({ label: "settled-image-note" }, async (testState) => {
      const { fixture, target, activeSession, before, previousLeaf, previousMessages, lifecycle } =
        await createPersistedImageNoteFixture(mocks, testState);
      const actualAttemptResult =
        await vi.importActual<typeof import("./attempt-result.js")>("./attempt-result.js");
      mocks.completeResult.mockImplementationOnce(
        actualAttemptResult.completeEmbeddedAttemptResult,
      );

      try {
        const database = openOpenClawAgentDatabase({ agentId: "main", path: target.storePath });
        // Prepare before instrumentation so the probes must observe cached statements too.
        const calibration = database.db.prepare("SELECT 1 AS value");
        const probes = {
          prepare: vi.spyOn(DatabaseSync.prototype, "prepare"),
          exec: vi.spyOn(DatabaseSync.prototype, "exec"),
          get: vi.spyOn(StatementSync.prototype, "get"),
          all: vi.spyOn(StatementSync.prototype, "all"),
          run: vi.spyOn(StatementSync.prototype, "run"),
          iterate: vi.spyOn(StatementSync.prototype, "iterate"),
        };
        const measured = await (async () => {
          try {
            database.db.exec("SELECT 1");
            database.db.prepare("SELECT 1");
            calibration.get();
            calibration.all();
            calibration.run();
            expect([...calibration.iterate()]).toEqual([{ value: 1 }]);
            for (const [name, probe] of Object.entries(probes)) {
              expect(
                probe.mock.calls.length,
                `positive parent ${name} calibration`,
              ).toBeGreaterThan(0);
              probe.mockClear();
            }

            const result = await runEmbeddedAttemptSettledPhase(fixture.input);
            return {
              result,
              parentSql: Object.fromEntries(
                Object.entries(probes).map(([name, probe]) => [name, probe.mock.calls.length]),
              ),
            };
          } finally {
            Object.values(probes).forEach((probe) => probe.mockRestore());
          }
        })();

        const after = await loadTranscriptEvents(target);
        expect(after.slice(0, before.length)).toEqual(before);
        expect(after).toHaveLength(before.length + 1);
        const reopened = SessionManager.open(target);
        const appended = reopened.getLeafEntry();
        expect(appended).toMatchObject({
          type: "message",
          parentId: previousLeaf,
          message: {
            role: "custom",
            customType: "openclaw.system-note",
            display: true,
            content: expect.stringMatching(/1.*image contents.*unavailable.*resend.*not claim/is),
            details: {
              source: "prompt-image-hydration",
              runId: fixture.input.attempt.runId,
              failedMediaCount: 1,
            },
            timestamp: expect.any(Number),
          },
        });
        if (appended?.type !== "message") {
          throw new Error("Expected a durable image failure message");
        }
        expect(appended.message).not.toHaveProperty("excludeFromContext");
        const expectedMessages = [...previousMessages, appended.message];
        expect(activeSession.messages).toEqual(expectedMessages);
        expect(measured.result.messagesSnapshot).toEqual(expectedMessages);
        expect(fixture.unsubscribe).toHaveBeenCalledOnce();
        expect(fixture.detachBackend).toHaveBeenCalledOnce();
        expect(measured.parentSql).toEqual({
          prepare: 0,
          exec: 0,
          get: 0,
          all: 0,
          run: 0,
          iterate: 0,
        });
      } finally {
        await lifecycle.dispose();
      }
    });
  });

  it.each([
    { storage: "file-backed", redact: false },
    { storage: "file-backed", redact: true },
    { storage: "incognito", redact: true },
  ] as const)(
    "retains one canonical $storage image note through configured fallback (redacted: $redact)",
    async ({ storage, redact }) => {
      await withOpenClawTestState({ label: "settled-image-note-redaction" }, async (testState) => {
        const first = await createPersistedImageNoteFixture(mocks, testState, storage);
        const { target, before, previousMessages } = first;
        const config = redact ? { logging: { redactPatterns: ["run-1"] } } : undefined;
        const actualAttemptResult =
          await vi.importActual<typeof import("./attempt-result.js")>("./attempt-result.js");
        const cleanupFailure = new Error("backend detach failed after image note publication");
        first.fixture.detachBackend.mockImplementationOnce(() => {
          throw cleanupFailure;
        });
        const attempts: Array<typeof first> = [];
        const routes: string[] = [];
        const joined: Array<typeof first> = [];
        const onError = vi.fn();
        try {
          const fallback = await runWithModelFallback({
            cfg: config,
            provider: "fixture-provider",
            model: "fixture-model",
            manifestPlugins: [],
            fallbacksOverride: ["fixture-next/fixture-model"],
            skipAuthProfileRuntime: true,
            runId: first.fixture.input.attempt.runId,
            onError,
            run: async (provider) => {
              const current =
                attempts.length === 0
                  ? first
                  : await createPersistedImageNoteFixture(mocks, testState, storage, true);
              routes.push(provider);
              attempts.push(current);
              if (current !== first) {
                expect(joined).toEqual([first]);
                expect(current.manager).not.toBe(first.manager);
                expect(current.lifecycle).not.toBe(first.lifecycle);
                expect(current.previousMessages).toEqual(first.activeSession.messages);
              }
              current.fixture.input.attempt.config = config;
              mocks.completeResult.mockImplementation(
                actualAttemptResult.completeEmbeddedAttemptResult,
              );
              expect(current.fixture.input.attempt.runId).toBe(first.fixture.input.attempt.runId);
              try {
                return await runEmbeddedAttemptSettledPhase(current.fixture.input);
              } finally {
                await current.lifecycle.dispose();
                joined.push(current);
              }
            },
          });
          expect(routes).toEqual(["fixture-provider", "fixture-next"]);
          expect(fallback.provider).toBe("fixture-next");
          expect(onError).toHaveBeenCalledOnce();
          expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({
              error: cleanupFailure,
              attempt: 1,
              total: 2,
            }),
          );
          expect(attempts).toHaveLength(2);
          expect(joined).toEqual(attempts);
          const after = await loadTranscriptEvents(target);
          expect(after.slice(0, before.length)).toEqual(before);
          expect(after).toHaveLength(before.length + 1);
          const stored = SessionManager.open(target).getLeafEntry();
          expect(stored).toMatchObject({
            type: "message",
            message: { role: "custom", customType: "openclaw.system-note" },
          });
          if (stored?.type !== "message") {
            throw new Error("Expected a durable image failure message");
          }
          if (redact) {
            expect(JSON.stringify(stored.message)).not.toContain("run-1");
          } else {
            expect(stored.message).toMatchObject({ details: { runId: "run-1" } });
          }
          const expected = [...previousMessages, stored.message];
          expect(fallback.result.messagesSnapshot).toEqual(expected);
          for (const attempt of attempts) {
            expect(attempt.activeSession.messages).toEqual(expected);
            expect(attempt.fixture.unsubscribe).toHaveBeenCalledOnce();
            expect(attempt.fixture.detachBackend).toHaveBeenCalledOnce();
            expect(attempt.fixture.clearTimers).toHaveBeenCalledOnce();
          }
          expect(mocks.clearActiveEmbeddedRun).toHaveBeenCalledTimes(2);
          expect(mocks.completeResult).toHaveBeenCalledOnce();
        } finally {
          await first.lifecycle.dispose();
          await Promise.all(attempts.map((attempt) => attempt.lifecycle.dispose()));
        }
      });
    },
  );

  it.each(["file-backed", "incognito"] as const)(
    "does not republish a historical image note omitted by compaction (%s)",
    async (storage) => {
      await withOpenClawTestState({ label: "settled-image-note-context" }, async (testState) => {
        const first = await createPersistedImageNoteFixture(mocks, testState, storage);
        try {
          await runEmbeddedAttemptSettledPhase(first.fixture.input);
        } finally {
          await first.lifecycle.dispose();
        }
        const source = await SessionManager.openAsync(first.target, testState.workspaceDir);
        const kept = source.appendCustomMessageEntry("retained-context", "Current context", true);
        source.appendCompaction("Earlier image failure summarized", kept, 100);
        const current = await createPersistedImageNoteFixture(mocks, testState, storage, true);
        try {
          const expected = current.manager.buildSessionContext().messages;
          expect(expected).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({ customType: "openclaw.system-note" }),
            ]),
          );
          const before = await loadTranscriptEvents(current.target);
          const actualAttemptResult =
            await vi.importActual<typeof import("./attempt-result.js")>("./attempt-result.js");
          mocks.completeResult.mockImplementation(
            actualAttemptResult.completeEmbeddedAttemptResult,
          );

          const result = await runEmbeddedAttemptSettledPhase(current.fixture.input);

          expect(await loadTranscriptEvents(current.target)).toEqual(before);
          expect(current.manager.getLeafId()).toBe(current.previousLeaf);
          expect(current.manager.buildSessionContext().messages).toEqual(expected);
          expect(current.activeSession.messages).toEqual(expected);
          expect(result.messagesSnapshot).toEqual(expected);
          expect(current.fixture.unsubscribe).toHaveBeenCalledOnce();
          expect(current.fixture.detachBackend).toHaveBeenCalledOnce();
        } finally {
          await current.lifecycle.dispose();
        }
      });
    },
  );

  it.each(
    (["file-backed", "incognito"] as const).flatMap((storage) =>
      (["none", "side", "side-dirty", "controls-dirty", "visible"] as const).map((intervening) => ({
        storage,
        intervening,
      })),
    ),
  )(
    "reconciles a committed note against the visible tail ($storage, $intervening)",
    async ({ storage, intervening }) => {
      await withOpenClawTestState({ label: "settled-note-replay" }, async (testState) => {
        const {
          fixture,
          target,
          manager,
          activeSession,
          before,
          previousLeaf,
          previousMessages,
          lifecycle,
        } = await createPersistedImageNoteFixture(mocks, testState, storage);
        const state = activeSession.agent.state;
        const descriptor = Object.getOwnPropertyDescriptor(state, "messages");
        if (!descriptor) {
          throw new Error("Expected the fixture's loaded message view");
        }
        const publicationFailure = new Error("Note publication failed after persistence");
        Object.defineProperty(state, "messages", {
          configurable: true,
          get: () => previousMessages,
          set: () => {
            throw publicationFailure;
          },
        });
        try {
          let failure: unknown;
          try {
            await runEmbeddedAttemptSettledPhase(fixture.input);
          } catch (error) {
            failure = error;
          }
          expect(failure).toMatchObject({ cause: publicationFailure, committedTarget: target });
          expect(isRecordedModelFallbackStop(failure)).toBe(true);
          const committed = await loadTranscriptEvents(target);
          expect(committed.slice(0, before.length)).toEqual(before);
          expect(committed).toHaveLength(before.length + 1);
          const note = committed.at(-1);
          if (!isRecord(note) || typeof note.id !== "string") {
            throw new Error("Expected the committed note identity");
          }
          expect(failure).toMatchObject({ committedMessageId: note.id });
          expect(activeSession.messages).toEqual(previousMessages);
          expect(manager.getLeafId()).toBe(previousLeaf);
          expect(manager.buildSessionContext().messages).toEqual(previousMessages);

          const appendBeforeReconcile = (
            event: Parameters<typeof appendTranscriptEventSnapshotSync>[1],
          ) => {
            let needsReconcile = false;
            expect(
              appendTranscriptEventSnapshotSync(
                target,
                event,
                {},
                {
                  scheduleProjectionReconcile: false,
                  onProjectionReconcileNeeded: () => {
                    needsReconcile = true;
                  },
                },
              ),
            ).toMatchObject({ ok: true, value: { result: { appended: true } } });
            expect(needsReconcile).toBe(true);
          };
          if (intervening === "side" || intervening === "side-dirty") {
            const visibleMessages = SessionManager.open(target).buildSessionContext().messages;
            const sideEntry = {
              type: "custom",
              id: `${note.id}-side`,
              parentId: note.id,
              appendMode: "side",
              timestamp: "2026-01-01T00:00:00.000Z",
              customType: "side-observation",
              data: { observed: true },
            };
            if (intervening === "side-dirty") {
              appendBeforeReconcile(sideEntry);
            } else {
              await appendTranscriptEvent(target, sideEntry);
              await waitForSessionTranscriptProjection(target);
            }
            const stored = await loadTranscriptEvents(target);
            expect(stored.slice(0, committed.length)).toEqual(committed);
            expect(stored.slice(committed.length)).toEqual([sideEntry]);
            expect(resolveSessionTranscriptActiveLeafEntryId(stored)).toBe(note.id);
            if (intervening === "side") {
              expect(SessionManager.open(target).getLeafId()).toBe(note.id);
              expect(SessionManager.open(target).buildSessionContext().messages).toEqual(
                visibleMessages,
              );
            }
          } else if (intervening === "controls-dirty") {
            const firstControl = {
              type: "leaf",
              id: `${note.id}-first-control`,
              parentId: note.id,
              targetId: note.id,
              timestamp: "2026-01-01T00:00:00.000Z",
            };
            const secondControl = {
              ...firstControl,
              id: `${note.id}-second-control`,
              targetId: firstControl.id,
            };
            appendBeforeReconcile(firstControl);
            appendBeforeReconcile(secondControl);
            const stored = await loadTranscriptEvents(target);
            expect(stored.slice(0, committed.length)).toEqual(committed);
            expect(stored.slice(committed.length)).toEqual([firstControl, secondControl]);
            expect(selectVisibleTranscriptEvents(stored).at(-1)).toMatchObject({ id: note.id });
          } else if (intervening === "visible") {
            const later = SessionManager.open(target).appendMessage({
              role: "user",
              content: "A newer visible turn",
              timestamp: 2,
            });
            const stored = await loadTranscriptEvents(target);
            expect(stored.slice(0, committed.length)).toEqual(committed);
            expect(stored).toHaveLength(committed.length + 1);
            expect(SessionManager.open(target).getLeafId()).toBe(later);
          }
          const beforeReplay = await loadTranscriptEvents(target);

          Object.defineProperty(state, "messages", descriptor);
          const actualAttemptResult =
            await vi.importActual<typeof import("./attempt-result.js")>("./attempt-result.js");
          mocks.completeResult.mockImplementation(
            actualAttemptResult.completeEmbeddedAttemptResult,
          );
          const settleStream = mocks.settleStream.getMockImplementation()!;
          mocks.settleStream.mockImplementationOnce(async (...args) => ({
            ...(await settleStream(...args)),
            messagesSnapshot: [...previousMessages],
          }));

          if (intervening === "side-dirty" || intervening === "controls-dirty") {
            const database = openOpenClawAgentDatabase(
              toDatabaseOptions(resolveSqliteTranscriptScope(target)),
            );
            expect(sessionTranscriptIndexNeedsReconcile(database.db, target.sessionId)).toBe(true);
          }

          const replay = await runEmbeddedAttemptSettledPhase(fixture.input);

          const expected =
            intervening === "visible"
              ? previousMessages
              : SessionManager.open(target).buildSessionContext().messages;
          expect(await loadTranscriptEvents(target)).toEqual(beforeReplay);
          expect(activeSession.messages).toEqual(expected);
          expect(replay.messagesSnapshot).toEqual(expected);
          expect(manager.getLeafId()).toBe(previousLeaf);
          expect(manager.buildSessionContext().messages).toEqual(previousMessages);
        } finally {
          Object.defineProperty(state, "messages", descriptor);
          await lifecycle.dispose();
        }
      });
    },
  );

  it.each(["cancel before commit", "retarget after commit", "unknown reply after commit"] as const)(
    "keeps image note publication with its original owner: %s",
    async (transition) => {
      await withOpenClawTestState({ label: "settled-image-note-owner" }, async (testState) => {
        const { fixture, target, manager, activeSession, before, previousMessages, lifecycle } =
          await createPersistedImageNoteFixture(mocks, testState);
        const replacement = {
          ...target,
          sessionId: "replacement",
          sessionKey: "agent:main:replacement",
        };
        await upsertSessionEntryCore(replacement, {
          sessionId: replacement.sessionId,
          updatedAt: 1,
        });
        const replacementManager = SessionManager.open(replacement);
        replacementManager.appendMessage({
          role: "user",
          content: "Keep replacement",
          timestamp: 2,
        });
        await waitForSessionTranscriptProjection(replacement);
        const replacementBefore = await loadTranscriptEvents(replacement);
        const replacementMessages = replacementManager.buildSessionContext().messages;
        const committed = createDeferredCore();
        const release = createDeferredCore();
        const cancellation = new Error("image note owner cancelled before commit");
        let noteInFlight = false;
        let interceptedNotes = 0;
        let cancelledGrants = 0;
        const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
        const admissionSpy = vi
          .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
          .mockImplementation((admit) =>
            createAdmission((request, grant) => {
              if (
                transition === "cancel before commit" &&
                noteInFlight &&
                request.stage === "commit"
              ) {
                cancelledGrants++;
                fixture.input.runAbortController.abort(cancellation);
              }
              admit(request, grant);
            }),
          );
        const runOperation = workerStore.runSqliteWorkerStoreOperation;
        const operationSpy = vi
          .spyOn(workerStore, "runSqliteWorkerStoreOperation")
          .mockImplementation(
            <Operations extends SqliteWorkerOperations, T>(
              store: SqliteWorkerStore<Operations>,
              operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
              stateContext?: Parameters<typeof runOperation>[2],
              assertCurrent?: Parameters<typeof runOperation>[3],
              admission?: Parameters<typeof runOperation>[4],
              requireStateLifecycle?: Parameters<typeof runOperation>[5],
            ) =>
              runOperation(
                store,
                (scope) =>
                  operation({
                    execute: async (command, options) => {
                      const selected =
                        command.type === "database.domain.execute" &&
                        isRecord(command.input) &&
                        isRecord(command.input.command) &&
                        command.input.command.type === "session.transcript.appendMessage";
                      if (!selected) {
                        return await scope.execute(command, options);
                      }
                      interceptedNotes++;
                      noteInFlight = true;
                      try {
                        const result = await scope.execute(command, options);
                        if (transition === "unknown reply after commit") {
                          throw new SqliteWorkerError(
                            "Transcript reply outcome is unknown",
                            "outcome-unknown",
                          );
                        }
                        if (transition === "retarget after commit") {
                          committed.resolve();
                          await release.promise;
                        }
                        return result;
                      } finally {
                        noteInFlight = false;
                      }
                    },
                  }),
                stateContext,
                assertCurrent,
                admission,
                requireStateLifecycle,
              ),
          );
        const outcome = runEmbeddedAttemptSettledPhase(fixture.input).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        try {
          if (transition === "retarget after commit") {
            await Promise.race([
              committed.promise,
              outcome.then(() => {
                throw new Error("Attempt settled before the real image note commit boundary");
              }),
            ]);
            expect(activeSession.messages).toEqual(previousMessages);
            expect(mocks.completeResult).not.toHaveBeenCalled();
            manager.setSessionTarget(replacement);
            activeSession.agent.state.messages = [...replacementMessages];
            release.resolve();
          }
          const settled = await outcome;
          expect(interceptedNotes).toBe(1);
          expect(settled.ok).toBe(false);
          if (settled.ok) {
            throw new Error("Expected stale image note publication to be rejected");
          }
          expect(mocks.completeResult).not.toHaveBeenCalled();
          expect(fixture.unsubscribe).toHaveBeenCalledOnce();
          expect(fixture.detachBackend).toHaveBeenCalledOnce();
          expect(await loadTranscriptEvents(replacement)).toEqual(replacementBefore);
          const originalAfter = await loadTranscriptEvents(target);
          if (transition === "cancel before commit") {
            expect(cancelledGrants).toBe(1);
            expect(settled.error).toMatchObject({ message: cancellation.message });
            expect(isRecordedModelFallbackStop(settled.error)).toBe(false);
            expect(originalAfter).toEqual(before);
            expect(activeSession.messages).toEqual(previousMessages);
          } else {
            expect(cancelledGrants).toBe(0);
            expect(originalAfter.slice(0, before.length)).toEqual(before);
            expect(originalAfter).toHaveLength(before.length + 1);
            expect(originalAfter.at(-1)).toMatchObject({
              type: "message",
              message: {
                customType: "openclaw.system-note",
                details: { source: "prompt-image-hydration", runId: fixture.input.attempt.runId },
              },
            });
            expect(isRecordedModelFallbackStop(settled.error)).toBe(true);
            const committedEntry = SessionManager.open(target).getLeafEntry();
            expect(committedEntry).toBeDefined();
            if (transition === "retarget after commit") {
              expect(settled.error).toMatchObject({
                message: expect.stringMatching(/committed.*do not replay/is),
                committedMessageId: committedEntry?.id,
                committedTarget: target,
              });
              expect(activeSession.messages).toEqual(replacementMessages);
              expect(manager.getSessionTarget()?.sessionId).toBe(replacement.sessionId);
            } else {
              expect(settled.error).toMatchObject({ code: "outcome-unknown" });
              expect(settled.error).not.toHaveProperty("committedMessageId");
              expect(activeSession.messages).toEqual(previousMessages);
              operationSpy.mockRestore();
              admissionSpy.mockRestore();
              const actualAttemptResult =
                await vi.importActual<typeof import("./attempt-result.js")>("./attempt-result.js");
              mocks.completeResult.mockImplementation(
                actualAttemptResult.completeEmbeddedAttemptResult,
              );
              const settleStream = mocks.settleStream.getMockImplementation()!;
              mocks.settleStream.mockImplementationOnce(async (...args) => ({
                ...(await settleStream(...args)),
                messagesSnapshot: [...previousMessages],
              }));
              const replay = await runEmbeddedAttemptSettledPhase(fixture.input);
              const expected = SessionManager.open(target).buildSessionContext().messages;
              expect(await loadTranscriptEvents(target)).toEqual(originalAfter);
              expect(activeSession.messages).toEqual(expected);
              expect(replay.messagesSnapshot).toEqual(expected);
            }
          }
        } finally {
          release.resolve();
          await outcome;
          operationSpy.mockRestore();
          admissionSpy.mockRestore();
          await lifecycle.dispose();
        }
      });
    },
  );

  it("carries a successful hidden target through settlement into the terminal receipt", async () => {
    const fixture = createFixture(mocks);
    fixture.input.prepared.toolBase.nestedToolActivities.push(
      createNestedToolActivity({
        runId: "run-test",
        scopeId: "scope-test",
        afterEntryId: null,
        startOrder: 0,
        parentToolCallId: "outer-exec",
        toolCallId: "tool_search_code:outer-exec:read:1",
        toolName: "read",
        input: { path: "qa/scenarios/index.yaml" },
        result: {
          content: [{ type: "text", text: "QA scenario pack mission" }],
          details: {},
        },
        isError: false,
        startedAt: 1,
        timestamp: 2,
      }),
      createNestedToolActivity({
        runId: "run-test",
        scopeId: "scope-test",
        afterEntryId: null,
        startOrder: 0,
        parentToolCallId: "outer-exec",
        toolCallId: "tool_search_code:outer-exec:write:2",
        toolName: "write",
        input: { path: "qa/scenarios/index.yaml", content: "invalid" },
        result: {
          content: [{ type: "text", text: "write failed" }],
          details: {},
        },
        isError: true,
        startedAt: 3,
        timestamp: 4,
      }),
    );
    const actualStreamSettle = await vi.importActual<typeof import("./attempt-stream-settle.js")>(
      "./attempt-stream-settle.js",
    );
    const actualAttemptResult =
      await vi.importActual<typeof import("./attempt-result.js")>("./attempt-result.js");
    mocks.settleStream.mockImplementationOnce(actualStreamSettle.settleEmbeddedAttemptStream);
    mocks.completeResult.mockImplementationOnce(actualAttemptResult.completeEmbeddedAttemptResult);

    const attempt = await runEmbeddedAttemptSettledPhase(fixture.input);
    const prepared = prepareEmbeddedRunTerminal({
      runParams: {
        admittedRunContext: createTestAdmittedRunContext("run-1"),
        sessionId: "session-1",
        runId: "run-1",
        workspaceDir: "/workspace",
        prompt: "read the QA scenario index",
        trigger: "user",
        timeoutMs: 60_000,
      },
      attempt,
      currentAttemptCompletedAssistant: attempt.currentAttemptCompletedAssistant,
      provider: "openai",
      model: "model",
      activeErrorContext: { provider: "openai", model: "model" },
      authProfileStore: { version: 1, profiles: {} },
      sessionIdUsed: attempt.sessionIdUsed,
      sessionFileUsed: attempt.sessionFileUsed,
      outerContextTokenMeta: {},
      usageAccumulator: createUsageAccumulator(),
      contextRecoveryState: createEmbeddedRunContextRecoveryState(),
      resolvedToolResultFormat: "markdown",
      terminalState: {
        outcome: { reason: "completed", status: "ok", stopReason: "stop" },
        signalOwnedInterruption: false,
      },
    });

    expect(
      (
        prepared.agentMeta as {
          terminalReceipt?: { successfulToolNames?: string[] };
        }
      ).terminalReceipt?.successfulToolNames,
    ).toEqual(["exec", "read"]);
  });

  it("preserves a prompt failure while still completing stream cleanup", async () => {
    const fixture = createFixture(mocks);
    const failure = new Error("prompt failed");
    mocks.runPrompt.mockRejectedValueOnce(failure);
    fixture.unsubscribe.mockImplementationOnce(() => {
      fixture.order.push("unsubscribe");
      throw new Error("unsubscribe failed");
    });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).rejects.toBe(failure);

    expect(mocks.settleStream).not.toHaveBeenCalled();
    expect(mocks.completeResult).not.toHaveBeenCalled();
    expect(fixture.clearTimers).toHaveBeenCalledOnce();
    expect(fixture.detachBackend).toHaveBeenCalledWith(fixture.queueHandle);
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.stringContaining("unsubscribe failed, possible resource leak"),
    );
  });

  it("releases the active run when backend cleanup throws during a failed prompt", async () => {
    const fixture = createFixture(mocks);
    const failure = new Error("prompt failed");
    mocks.runPrompt.mockRejectedValueOnce(failure);
    fixture.detachBackend.mockImplementationOnce(() => {
      fixture.order.push("detach-backend");
      throw new Error("backend detach failed");
    });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).rejects.toBe(failure);

    expect(mocks.clearActiveEmbeddedRun).toHaveBeenCalledOnce();
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.stringContaining("backend detach failed, possible resource leak"),
    );
  });

  it("reports a backend cleanup failure after releasing a successful run", async () => {
    const fixture = createFixture(mocks);
    const failure = new Error("backend detach failed");
    fixture.detachBackend.mockImplementationOnce(() => {
      fixture.order.push("detach-backend");
      throw failure;
    });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).rejects.toBe(failure);

    expect(mocks.clearActiveEmbeddedRun).toHaveBeenCalledOnce();
  });

  it("reports active-run cleanup failure after detaching the backend", async () => {
    const fixture = createFixture(mocks);
    const failure = new Error("active run cleanup failed");
    mocks.clearActiveEmbeddedRun.mockImplementationOnce(() => {
      fixture.order.push("clear-active-run");
      throw failure;
    });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).rejects.toBe(failure);

    expect(fixture.detachBackend).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "retains child receipts for logical-run settlement (yielded: %s)",
    async (yieldDetected) => {
      const fixture = createFixture(mocks);
      const acceptedSessionSpawns = [
        {
          runId: "child-run",
          childSessionKey: "agent:main:subagent:child",
          expectsCompletionMessage: true,
        },
      ];
      mocks.completeResult.mockReturnValueOnce({
        ...fixture.result,
        terminal: { kind: "ok" },
        yieldDetected,
        acceptedSessionSpawns,
      });

      const result = await runEmbeddedAttemptSettledPhase(fixture.input);

      expect(result.acceptedSessionSpawns).toEqual(acceptedSessionSpawns);
      expect(fixture.order).toContain("clear-active-run");
      expect(mocks.markRequesterTurnYielded).not.toHaveBeenCalled();
      expect(mocks.settleRequesterAfterSessionSpawns).not.toHaveBeenCalled();
    },
  );

  it("defaults a source-less settlement failure without dropping it", async () => {
    const fixture = createFixture(mocks);
    const failure = new Error("settlement failed");
    mocks.settleStream.mockImplementationOnce(async () => {
      return {
        promptError: failure,
        promptErrorSource: null,
        timedOutDuringCompaction: true,
        messagesSnapshot: [],
        sessionIdUsed: "settled-session",
        lastAssistant: undefined,
        currentAttemptAssistant: undefined,
        attemptUsage: undefined,
        promptCache: undefined,
        lastCallUsage: undefined,
        compactionOccurredThisAttempt: false,
      };
    });

    await runEmbeddedAttemptSettledPhase(fixture.input);

    expect(fixture.state.terminal).toEqual({
      kind: "failed",
      source: "prompt",
      error: failure,
      timeoutObservation: "compaction",
    });
  });
});
