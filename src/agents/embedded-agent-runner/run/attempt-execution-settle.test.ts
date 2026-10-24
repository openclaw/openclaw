import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import { appendTranscriptEventSnapshotSync } from "../../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { appendPreparedTranscriptEvent } from "../../../config/sessions/session-transcript-event.js";
import { sessionTranscriptIndexNeedsReconcile } from "../../../config/sessions/session-transcript-index.js";
import { waitForSessionTranscriptProjection } from "../../../config/sessions/session-transcript-reconcile.js";
import { resolveSessionTranscriptActiveLeafEntryId } from "../../../config/sessions/transcript-tree.js";
import { selectVisibleTranscriptEvents } from "../../../config/sessions/transcript-visible-events.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as workerProbe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import * as workerStore from "../../../infra/sqlite-worker-store.js";
import type { SqliteWorkerOperations } from "../../../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { runWithModelFallback } from "../../model-fallback-runner.js";
import { isRecordedModelFallbackStop } from "../../model-fallback-stop.js";
import type { AgentMessage } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/session-manager.js";

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
// mock-isolation: Settlement fixtures observe detach without mutating the live native-run owner.
vi.mock("../runs.js", () => ({ detachActiveEmbeddedRun: mocks.clearActiveEmbeddedRun }));
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
import { runEmbeddedAttemptSettledPhase as settle } from "./attempt-settle.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.completeResult.mockReset();
});

async function useActualResult(once = false) {
  const { completeEmbeddedAttemptResult } =
    await vi.importActual<typeof import("./attempt-result.js")>("./attempt-result.js");
  if (once) {
    mocks.completeResult.mockImplementationOnce(completeEmbeddedAttemptResult);
  } else {
    mocks.completeResult.mockImplementation(completeEmbeddedAttemptResult);
  }
}

function replayMessages(messagesSnapshot: AgentMessage[]) {
  const settleStream = mocks.settleStream.getMockImplementation()!;
  mocks.settleStream.mockImplementationOnce(async (...args) => ({
    ...(await settleStream(...args)),
    messagesSnapshot: [...messagesSnapshot],
  }));
}

type NoteFixture = Awaited<ReturnType<typeof createPersistedImageNoteFixture>>;
type Storage = "file-backed" | "incognito";
async function withNotes(
  storage: Storage,
  run: (
    first: NoteFixture,
    reopen: () => Promise<NoteFixture>,
    state: OpenClawTestState,
  ) => Promise<void>,
) {
  await withOpenClawTestState({ label: "settled-image-note" }, async (state) => {
    const owned: NoteFixture[] = [];
    const create = async (reopen = false) => {
      const note = await createPersistedImageNoteFixture(mocks, state, storage, reopen);
      owned.push(note);
      return note;
    };
    try {
      await run(await create(), () => create(true), state);
    } finally {
      await Promise.all(owned.map(({ lifecycle }) => lifecycle.dispose()));
    }
  });
}
const imageNote = {
  role: "custom",
  customType: "openclaw.system-note",
  display: true,
  content: expect.stringMatching(/1.*image contents.*unavailable.*resend.*not claim/is),
};
function expectViews(
  f: NoteFixture,
  result: { messagesSnapshot: AgentMessage[] },
  expected: AgentMessage[],
) {
  expect(f.activeSession.messages).toEqual(expected);
  expect(result.messagesSnapshot).toEqual(expected);
}
function expectAppended(before: unknown[], after: unknown[], added = 1) {
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after).toHaveLength(before.length + added);
}
function expectNoteEntry(manager: SessionManager) {
  const entry = manager.getLeafEntry();
  expect(entry).toMatchObject({ type: "message", message: imageNote });
  if (entry?.type !== "message") {
    throw new Error("Expected a durable image failure message");
  }
  expect(entry.message).not.toHaveProperty("excludeFromContext");
  return entry;
}

describe("runEmbeddedAttemptSettledPhase", () => {
  it("runs prompt and finalization, cleans stream resources, then projects the result", async () => {
    const fixture = createFixture(mocks);
    // Cleanup must release the exact attachment registered for this attempt's stream.
    const registration = {} as NonNullable<
      typeof fixture.input.preparedStreamRuntime.stream.registration
    >;
    fixture.input.preparedStreamRuntime.stream.registration = registration;

    const result = await settle(fixture.input);

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
    expect(fixture.state).toMatchObject({
      beforeAgentRunBlockedBy: "before_agent",
      terminal: { kind: "ok" },
      trajectoryEndRecorded: true,
    });
    expect(fixture.sessionRuntimeState).toMatchObject({
      prePromptMessageCount: 4,
      promptCache: { cacheRead: 1 },
    });
    expect(fixture.detachBackend).toHaveBeenCalledWith(fixture.queueHandle);
    expect(mocks.clearActiveEmbeddedRun).toHaveBeenCalledWith(
      "session-1",
      fixture.queueHandle,
      "agent:main",
      "/tmp/session.jsonl",
      undefined,
      registration,
    );
  });

  it("persists image failure notes after after-turn transcript reconciliation", async () => {
    const fixture = createFixture(mocks);
    fixture.sessionRuntimeState.currentTurnImageFailureCount = 1;
    await settle(fixture.input);

    expect(fixture.sessionManager.appendMessageAsync).toHaveBeenCalledWith(
      expect.objectContaining(imageNote),
    );
    expect(fixture.sessionManager.appendMessageAsync.mock.calls[0]?.[0]).not.toHaveProperty(
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
    await withNotes("file-backed", async (f) => {
      const { fixture, target, before, previousLeaf, previousMessages } = f;
      await useActualResult(true);
      const database = openOpenClawAgentDatabase({ agentId: "main", path: target.storePath });
      // Prepare before instrumentation so the probes must observe cached statements too.
      const calibration = database.db.prepare("SELECT 1 AS value");
      const probes = observeMainThreadSql();
      const result = await (async () => {
        try {
          database.db.exec("SELECT 1");
          database.db.prepare("SELECT 1");
          calibration.get();
          calibration.all();
          calibration.run();
          expect([...calibration.iterate()]).toEqual([{ value: 1 }]);
          for (const probe of probes.calls) {
            expect(probe).toHaveBeenCalled();
          }
          probes.clear();

          const measuredResult = await settle(fixture.input);
          probes.expectIdle();
          return measuredResult;
        } finally {
          probes.restore();
        }
      })();

      const after = await loadTranscriptEvents(target);
      expectAppended(before, after);
      const appended = expectNoteEntry(SessionManager.open(target));
      expect(appended).toMatchObject({
        parentId: previousLeaf,
        message: {
          details: {
            source: "prompt-image-hydration",
            runId: fixture.input.attempt.runId,
            failedMediaCount: 1,
          },
          timestamp: expect.any(Number),
        },
      });
      expectViews(f, result, [...previousMessages, appended.message]);
    });
  });

  it.each([
    { storage: "file-backed", redact: false },
    { storage: "file-backed", redact: true },
    { storage: "incognito", redact: true },
  ] as const)(
    "retains one canonical $storage image note through configured fallback (logging patterns: $redact)",
    async ({ storage, redact }) => {
      await withNotes(storage, async (first, reopen) => {
        const { target, before, previousMessages } = first;
        const config = redact ? { logging: { redactPatterns: ["run-1"] } } : undefined;
        const cleanupFailure = new Error("backend detach failed after image note publication");
        first.fixture.detachBackend.mockImplementationOnce(() => {
          throw cleanupFailure;
        });
        const attempts: Array<typeof first> = [];
        const joined: Array<typeof first> = [];
        const onError = vi.fn();
        const fallback = await runWithModelFallback({
          cfg: config,
          provider: "fixture-provider",
          model: "fixture-model",
          manifestPlugins: [],
          fallbacksOverride: ["fixture-next/fixture-model"],
          skipAuthProfileRuntime: true,
          runId: first.fixture.input.attempt.runId,
          onError,
          run: async () => {
            const current = attempts.length === 0 ? first : await reopen();
            attempts.push(current);
            if (current !== first) {
              expect(joined).toEqual([first]);
            }
            current.fixture.input.attempt.config = config;
            await useActualResult();
            try {
              return await settle(current.fixture.input);
            } finally {
              await current.lifecycle.dispose();
              joined.push(current);
            }
          },
        });
        expect(fallback.provider).toBe("fixture-next");
        expect(onError).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ error: cleanupFailure, attempt: 1, total: 2 }),
        );
        expect(attempts).toHaveLength(2);
        expect(joined).toEqual(attempts);
        const after = await loadTranscriptEvents(target);
        expectAppended(before, after);
        const stored = expectNoteEntry(await SessionManager.openAsync(target));
        expect(stored.message).toMatchObject({ details: { runId: "run-1" } });
        const expected = [...previousMessages, stored.message];
        expect(fallback.result.messagesSnapshot).toEqual(expected);
        for (const attempt of attempts) {
          expect(attempt.activeSession.messages).toEqual(expected);
        }
      });
    },
  );

  it.each(["file-backed", "incognito"] as const)(
    "does not republish a historical image note omitted by compaction (%s)",
    async (storage) => {
      await withNotes(storage, async (first, reopen, testState) => {
        try {
          await settle(first.fixture.input);
        } finally {
          await first.lifecycle.dispose();
        }
        const source = await SessionManager.openAsync(first.target, testState.workspaceDir);
        const kept = await source.appendCustomMessageEntryAsync(
          "retained-context",
          "Current context",
          true,
        );
        await source.appendCompactionAsync("Earlier image failure summarized", kept, 100);
        const current = await reopen();
        const expected = current.manager.buildSessionContext().messages;
        expect(expected).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ customType: "openclaw.system-note" })]),
        );
        const before = await loadTranscriptEvents(current.target);
        await useActualResult();

        const result = await settle(current.fixture.input);

        expect(await loadTranscriptEvents(current.target)).toEqual(before);
        expectViews(current, result, expected);
      });
    },
  );

  it.each(
    (["file-backed", "incognito"] as const).flatMap((storage) =>
      (["none", "side", "side-dirty", "controls-dirty", "visible"] as const)
        // Memory actors publish their projection atomically and have no dirty SQLite index.
        .filter(
          (intervening) =>
            storage === "file-backed" ||
            (intervening !== "side-dirty" && intervening !== "controls-dirty"),
        )
        .map((intervening) => ({ storage, intervening })),
    ),
  )(
    "reconciles a committed note against the visible tail ($storage, $intervening)",
    async ({ storage, intervening }) => {
      await withNotes(storage, async (f) => {
        const { fixture, target, manager, activeSession, before, previousLeaf, previousMessages } =
          f;
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
          const failure: unknown = await settle(fixture.input).catch((error: unknown) => error);
          expect(failure).toMatchObject({ cause: publicationFailure, committedTarget: target });
          expect(isRecordedModelFallbackStop(failure)).toBe(true);
          const committed = await loadTranscriptEvents(target);
          expectAppended(before, committed);
          const note = committed.at(-1);
          if (!isRecord(note) || typeof note.id !== "string") {
            throw new Error("Expected the committed note identity");
          }
          expect(failure).toMatchObject({ committedMessageId: note.id });
          expect(activeSession.messages).toEqual(previousMessages);

          const appendBeforeReconcile = (
            event: Parameters<typeof appendTranscriptEventSnapshotSync>[1],
          ) => {
            const needsReconcile = vi.fn();
            expect(
              appendTranscriptEventSnapshotSync(
                target,
                event,
                {},
                {
                  scheduleProjectionReconcile: false,
                  onProjectionReconcileNeeded: needsReconcile,
                },
              ),
            ).toMatchObject({ ok: true, value: { result: { appended: true } } });
            expect(needsReconcile).toHaveBeenCalled();
          };
          const side = intervening === "side" || intervening === "side-dirty";
          const visibleMessages =
            intervening === "side"
              ? (await SessionManager.openAsync(target)).buildSessionContext().messages
              : undefined;
          const eventBase = { parentId: note.id, timestamp: "2026-01-01T00:00:00.000Z" };
          const firstControlId = `${note.id}-first-control`;
          const events = side
            ? [
                {
                  ...eventBase,
                  type: "custom" as const,
                  id: `${note.id}-side`,
                  appendMode: "side" as const,
                  customType: "side-observation",
                  data: { observed: true },
                },
              ]
            : intervening === "controls-dirty"
              ? [
                  { ...eventBase, type: "leaf" as const, id: firstControlId, targetId: note.id },
                  {
                    ...eventBase,
                    type: "leaf" as const,
                    id: `${note.id}-second-control`,
                    targetId: firstControlId,
                  },
                ]
              : [];
          for (const event of events) {
            if (intervening.endsWith("-dirty")) {
              appendBeforeReconcile(event);
            } else {
              await appendPreparedTranscriptEvent(target, event, () => {});
              await waitForSessionTranscriptProjection(target);
            }
          }
          if (events.length) {
            const stored = await loadTranscriptEvents(target);
            expect(stored).toEqual([...committed, ...events]);
            if (side) {
              expect(resolveSessionTranscriptActiveLeafEntryId(stored)).toBe(note.id);
              if (intervening === "side") {
                const visible = await SessionManager.openAsync(target);
                expect(visible.getLeafId()).toBe(note.id);
                expect(visible.buildSessionContext().messages).toEqual(visibleMessages);
              }
            } else {
              expect(selectVisibleTranscriptEvents(stored).at(-1)).toMatchObject({ id: note.id });
            }
          } else if (intervening === "visible") {
            const later = await (
              await SessionManager.openAsync(target)
            ).appendMessageAsync({
              role: "user",
              content: "A newer visible turn",
              timestamp: 2,
            });
            const stored = await loadTranscriptEvents(target);
            expectAppended(committed, stored);
            expect((await SessionManager.openAsync(target)).getLeafId()).toBe(later);
          }
          const beforeReplay = await loadTranscriptEvents(target);

          Object.defineProperty(state, "messages", descriptor);
          await useActualResult();
          replayMessages(previousMessages);

          if (intervening === "side-dirty" || intervening === "controls-dirty") {
            const database = openOpenClawAgentDatabase(
              toDatabaseOptions(resolveSqliteTranscriptScope(target)),
            );
            expect(sessionTranscriptIndexNeedsReconcile(database.db, target.sessionId)).toBe(true);
          }

          const replay = await settle(fixture.input);

          const expected =
            intervening === "visible"
              ? previousMessages
              : (await SessionManager.openAsync(target)).buildSessionContext().messages;
          expect(await loadTranscriptEvents(target)).toEqual(beforeReplay);
          expectViews(f, replay, expected);
          expect(manager.getLeafId()).toBe(previousLeaf);
          expect(manager.buildSessionContext().messages).toEqual(previousMessages);
        } finally {
          Object.defineProperty(state, "messages", descriptor);
        }
      });
    },
  );

  it.each(["cancel before commit", "retarget after commit", "unknown reply after commit"] as const)(
    "keeps image note publication with its original owner: %s",
    async (transition) => {
      await withNotes("file-backed", async (f) => {
        const { fixture, target, manager, activeSession, before, previousMessages } = f;
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
        const admissionSpy = workerProbe.admission(workerAdmission, (request, grant, admit) => {
          if (transition === "cancel before commit" && noteInFlight && request.stage === "commit") {
            cancelledGrants++;
            fixture.input.runAbortController.abort(cancellation);
          }
          admit(request, grant);
        });
        const runOperation = workerStore.runSqliteWorkerStoreOperation;
        const operationSpy = vi
          .spyOn(workerStore, "runSqliteWorkerStoreOperation")
          .mockImplementation(
            <Operations extends SqliteWorkerOperations, T>(
              ...args: Parameters<typeof runOperation<Operations, T>>
            ) => {
              const [store, operation, ...controls] = args;
              return runOperation(
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
                ...controls,
              );
            },
          );
        const outcome = settle(fixture.input).then(
          () => {
            throw new Error("Expected stale image note publication to be rejected");
          },
          (error: unknown) => error,
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
          const error = await outcome;
          expect(interceptedNotes).toBe(1);
          expect(mocks.completeResult).not.toHaveBeenCalled();
          expect(fixture.unsubscribe).toHaveBeenCalledOnce();
          expect(fixture.detachBackend).toHaveBeenCalledOnce();
          expect(await loadTranscriptEvents(replacement)).toEqual(replacementBefore);
          const originalAfter = await loadTranscriptEvents(target);
          if (transition === "cancel before commit") {
            expect(cancelledGrants).toBe(1);
            expect(error).toMatchObject({ message: cancellation.message });
            expect(isRecordedModelFallbackStop(error)).toBe(false);
            expect(originalAfter).toEqual(before);
            expect(activeSession.messages).toEqual(previousMessages);
          } else {
            expect(cancelledGrants).toBe(0);
            expectAppended(before, originalAfter);
            expect(originalAfter.at(-1)).toMatchObject({
              type: "message",
              message: {
                customType: "openclaw.system-note",
                details: { source: "prompt-image-hydration", runId: fixture.input.attempt.runId },
              },
            });
            expect(isRecordedModelFallbackStop(error)).toBe(true);
            const committedEntry = SessionManager.open(target).getLeafEntry();
            expect(committedEntry).toBeDefined();
            if (transition === "retarget after commit") {
              expect(error).toMatchObject({
                message: expect.stringMatching(/committed.*do not replay/is),
                committedMessageId: committedEntry?.id,
                committedTarget: target,
              });
              expect(activeSession.messages).toEqual(replacementMessages);
              expect(manager.getSessionTarget()?.sessionId).toBe(replacement.sessionId);
            } else {
              expect(error).toMatchObject({ code: "outcome-unknown" });
              expect(error).not.toHaveProperty("committedMessageId");
              expect(activeSession.messages).toEqual(previousMessages);
              operationSpy.mockRestore();
              admissionSpy.mockRestore();
              await useActualResult();
              replayMessages(previousMessages);
              const replay = await settle(fixture.input);
              const expected = SessionManager.open(target).buildSessionContext().messages;
              expect(await loadTranscriptEvents(target)).toEqual(originalAfter);
              expectViews(f, replay, expected);
            }
          }
        } finally {
          release.resolve();
          try {
            await outcome;
          } finally {
            operationSpy.mockRestore();
            admissionSpy.mockRestore();
          }
        }
      });
    },
  );

  it("carries successful hidden targets through settlement", async () => {
    const fixture = createFixture(mocks);
    fixture.input.prepared.toolBase.nestedToolActivityState.successfulToolNames.add("read");
    const actualStreamSettle = await vi.importActual<typeof import("./attempt-stream-settle.js")>(
      "./attempt-stream-settle.js",
    );
    mocks.settleStream.mockImplementationOnce(actualStreamSettle.settleEmbeddedAttemptStream);
    await useActualResult(true);

    const attempt = await settle(fixture.input);
    expect(attempt.successfulNestedToolNames).toEqual(["read"]);
    expect(attempt.toolMetas).toEqual([{ toolName: "exec", isError: false, replaySafe: false }]);
  });

  it("preserves a prompt failure while still completing stream cleanup", async () => {
    const fixture = createFixture(mocks);
    const failure = new Error("prompt failed");
    mocks.runPrompt.mockRejectedValueOnce(failure);
    fixture.unsubscribe.mockImplementationOnce(() => {
      fixture.order.push("unsubscribe");
      throw new Error("unsubscribe failed");
    });

    await expect(settle(fixture.input)).rejects.toBe(failure);

    expect(mocks.settleStream).not.toHaveBeenCalled();
    expect(mocks.completeResult).not.toHaveBeenCalled();
    expect(fixture.clearTimers).toHaveBeenCalledOnce();
    expect(fixture.detachBackend).toHaveBeenCalledWith(fixture.queueHandle);
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.stringContaining("unsubscribe failed, possible resource leak"),
    );
  });

  it("defaults a source-less settlement failure without dropping it", async () => {
    const fixture = createFixture(mocks);
    const failure = new Error("settlement failed");
    mocks.settleStream.mockImplementationOnce(async () => ({
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
    }));

    await settle(fixture.input);

    expect(fixture.state.terminal).toEqual({
      kind: "failed",
      source: "prompt",
      error: failure,
      timeoutObservation: "compaction",
    });
  });
});
