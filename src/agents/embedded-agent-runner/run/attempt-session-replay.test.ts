import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createFailureMessage } from "../../../../packages/agent-core/src/turn-interruption.js";
import {
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { resolveSessionTranscriptReadFence } from "../../../config/sessions/session-transcript-read-fence.js";
import type { ImageContent } from "../../../llm/types.js";
import { finalizeRuntimePromptImages } from "../../../media/runtime-prompt-image-provenance.js";
import { readVisibleSessionTranscriptMessageEntries } from "../../../plugin-sdk/session-transcript-runtime.js";
import {
  createUserTurnTranscriptRecorder,
  type PersistedUserTurnMessage,
} from "../../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { createAgentRunRestartAbortError } from "../../run-termination.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createOverflowAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import type { AgentSession } from "../../sessions/agent-session.js";
import { sessionManagerPrepareCurrentTurnReplay } from "../../sessions/session-manager-current-turn.js";
import { SessionManager } from "../../sessions/session-manager.js";
import type { AttemptContextEngine } from "./attempt-context-engine-helpers.js";
import {
  appendCompletedToolWork,
  appendOversizedCacheSnapshot,
  withInterruptedTurn,
  withReplaySession,
} from "./attempt-session-replay.test-support.js";
import { cleanupEmbeddedAttemptResources } from "./attempt-subscription-cleanup.js";
import { buildRuntimeContextCustomMessage } from "./runtime-context-prompt.js";

registerAgentSessionLoopTestLifecycle();

describe("context engine bootstrap", () => {
  it("bootstraps the context engine under the admitted user turn's read fence", async () => {
    // Unfenced, the engine imports the already-persisted current turn from the
    // transcript and the host appends it again after assembly; the next run
    // keeps one copy and every later provider byte shifts (prompt-cache bust).
    await withInterruptedTurn(
      false,
      async (fixture) => {
        let owner: SessionManager | undefined;
        const fences: unknown[] = [];
        const visibleEntryIds: string[][] = [];
        const bootstrap = vi.fn(async () => {
          fences.push(resolveSessionTranscriptReadFence(fixture.target));
          // What an engine that reconciles from the transcript would import.
          const entries = await readVisibleSessionTranscriptMessageEntries(fixture.target);
          visibleEntryIds.push(entries.map((entry) => entry.entryId));
        });
        try {
          await fixture.prepare(
            (manager) => {
              owner = manager;
            },
            {
              activeContextEngine: {
                info: { id: "fence-probe" },
                bootstrap,
              } as unknown as AttemptContextEngine,
            },
          );
        } finally {
          await cleanupEmbeddedAttemptResources({
            sessionManager: owner,
            flushPendingToolResultsAfterIdle: async () => {},
          });
        }
        const admission = fixture.attempt.userTurnTranscriptRecorder!.getAdmissionReceipt();
        expect(admission).toBeDefined();
        expect(bootstrap).toHaveBeenCalledTimes(1);
        // The pending turn is persisted and visible to an unfenced reader, but
        // bootstrap must not see it: an engine that imported it would emit the
        // turn a second time next to the host's own copy.
        const unfenced = await readVisibleSessionTranscriptMessageEntries(fixture.target);
        const unfencedIds = unfenced.map((entry) => entry.entryId);
        const admittedIndex = unfencedIds.indexOf(admission!.entryId);
        expect(admittedIndex).toBeGreaterThan(0);
        // Exactly the settled prefix, nothing hidden beyond the admitted turn.
        expect(visibleEntryIds[0]).toEqual(unfencedIds.slice(0, admittedIndex));
        expect(fences).toEqual([admission]);
      },
      { settledPrefix: true },
    );
  });
});

describe("interrupted canonical user replay", () => {
  it.each([
    { appendOnly: false, interruptedTurn: false, toolProgress: true },
    { appendOnly: true, interruptedTurn: false, toolProgress: true },
    { appendOnly: false, interruptedTurn: true, toolProgress: true },
    { appendOnly: true, interruptedTurn: true, toolProgress: true },
    { appendOnly: false, interruptedTurn: true, toolProgress: false },
    { appendOnly: true, interruptedTurn: true, toolProgress: false },
    { appendOnly: false, interruptedTurn: true, toolProgress: true, oversizedMetadata: true },
    { appendOnly: true, interruptedTurn: true, toolProgress: true, oversizedMetadata: true },
  ])(
    "replays one user after restart (carrier=$appendOnly, abort row=$interruptedTurn, tools=$toolProgress, oversized metadata=$oversizedMetadata)",
    async ({ appendOnly, interruptedTurn, toolProgress, oversizedMetadata }) => {
      let observedWalks = 0;
      const nativeReadFailures: unknown[] = [];
      const prepare = SessionManager.prototype[sessionManagerPrepareCurrentTurnReplay];
      const replayRead = vi
        .spyOn(SessionManager.prototype, sessionManagerPrepareCurrentTurnReplay)
        .mockImplementation(async function (this: SessionManager, ...args) {
          const sql = observeMainThreadSql();
          try {
            return await prepare.apply(this, args);
          } finally {
            observedWalks++;
            try {
              sql.expectIdle();
            } catch (error) {
              nativeReadFailures.push(error);
            } finally {
              sql.restore();
            }
          }
        });
      onTestFinished(() => replayRead.mockRestore());
      await withInterruptedTurn(
        appendOnly,
        async (fixture) => {
          const before = loadTranscriptEventsSync(fixture.target);
          await withReplaySession(fixture, appendOnly, async (session, submit) => {
            expect(fixture.attempt.userTurnTranscriptRecorder!.hasPersisted()).toBe(true);
            streamMocks.streamSimple.mockImplementation((model) =>
              createAssistantResultStream(
                createAssistant(model, [{ type: "text", text: "Continued from completed work" }]),
              ),
            );
            await submit();
            expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
            const messages = streamMocks.streamSimple.mock.calls[0]![1].messages;
            expect(
              messages.filter(
                (message: { role: string; content: unknown }) =>
                  message.role === "user" &&
                  JSON.stringify(message.content).includes(fixture.attempt.prompt),
              ),
            ).toHaveLength(1);
            if (toolProgress) {
              expect(JSON.stringify(messages)).not.toContain("Nested read completed");
              expect(messages).toContainEqual(
                expect.objectContaining({
                  role: "toolResult",
                  toolCallId: "completed-read",
                  content: [{ type: "text", text: "Already read: use this completed result" }],
                }),
              );
            }
            if (oversizedMetadata) {
              expect(
                messages.flatMap((message: { role: string; toolCallId?: string }) =>
                  message.role === "toolResult" ? [message.toolCallId] : [],
                ),
              ).toEqual(["completed-read-before-window", "completed-read"]);
            }
            expect(session.getLastAssistantText()).toBe("Continued from completed work");
            const after = loadTranscriptEventsSync(fixture.target);
            expect(after.slice(0, before.length)).toEqual(before);
            if (oversizedMetadata) {
              expect(
                after.filter(
                  (entry) =>
                    (entry as { message?: { role?: string } }).message?.role === "toolResult",
                ),
              ).toHaveLength(2);
            }
            expect(
              after.filter(
                (entry) => (entry as { message?: { role?: string } }).message?.role === "user",
              ),
            ).toHaveLength(1);
          });
        },
        { interruptedTurn, toolProgress, oversizedMetadata },
      );
      expect(observedWalks).toBeGreaterThan(0);
      expect(nativeReadFailures).toEqual([]);
    },
  );

  it.each([
    { appendOnly: false, queue: "steer" },
    { appendOnly: true, queue: "steer" },
    { appendOnly: false, queue: "follow-up" },
    { appendOnly: true, queue: "follow-up" },
  ])(
    "persists the next $queue user after replay with append-only context $appendOnly",
    async ({ appendOnly, queue }) => {
      await withInterruptedTurn(appendOnly, async (fixture) => {
        const before = loadTranscriptEventsSync(fixture.target);
        await withReplaySession(fixture, appendOnly, async (session, submit) => {
          const queuedText = "A distinct queued user request";
          const recorder =
            queue === "steer"
              ? createUserTurnTranscriptRecorder({
                  target: { ...fixture.target, sessionEntry: undefined },
                  input: { text: queuedText, timestamp: 2, idempotencyKey: "queued-user:user" },
                })
              : undefined;
          streamMocks.streamSimple.mockImplementation((model) =>
            createAssistantResultStream(
              createAssistant(model, [{ type: "text", text: "Both requests handled" }]),
            ),
          );
          try {
            if (recorder) {
              await recorder.stageApproved!({
                runId: fixture.attempt.runId,
                assertCurrent: () => {},
              });
              await session.steer(queuedText, undefined, recorder);
            } else {
              await session.followUp(queuedText);
            }
            await submit();
            expect(
              streamMocks.streamSimple.mock.calls.some(([, context]) =>
                JSON.stringify(context.messages).includes(queuedText),
              ),
            ).toBe(true);
            expect(loadTranscriptEventsSync(fixture.target).slice(0, before.length)).toEqual(
              before,
            );
            for (const [, context] of streamMocks.streamSimple.mock.calls) {
              expect(
                context.messages.filter(
                  (message: { role: string; content: unknown }) =>
                    message.role === "user" &&
                    JSON.stringify(message.content).includes(fixture.attempt.prompt),
                ),
              ).toHaveLength(1);
            }
            expect(
              SessionManager.open(fixture.target)
                .getBranch()
                .filter(
                  (entry) =>
                    entry.type === "message" &&
                    entry.message.role === "user" &&
                    JSON.stringify(entry.message.content).includes(queuedText),
                ),
            ).toHaveLength(1);
            if (recorder) {
              expect(recorder.hasPersisted()).toBe(true);
            }
          } finally {
            recorder?.finishPendingInput!("interrupted");
          }
        });
      });
    },
  );

  it("preserves current prompt images while reusing its durable user", async () => {
    const manager = SessionManager.inMemory();
    const user = {
      role: "user" as const,
      content: "Describe the current image",
      timestamp: 1,
      idempotencyKey: "image-turn:user",
      __openclaw: {
        senderName: "Synthetic sender",
        media: [{ path: "/synthetic/image.png", contentType: "image/png" }],
      },
    };
    manager.appendMessage(user);
    const { session } = await createTestSession({ sessionManager: manager });
    const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
    streamMocks.streamSimple.mockImplementation((model) =>
      createAssistantResultStream(
        createAssistant(model, [{ type: "text", text: "Image described" }]),
      ),
    );
    try {
      await session.prompt(user.content, {
        persistedUserIdempotencyKey: user.idempotencyKey,
        images: finalizeRuntimePromptImages([{ image, factIndex: 0 }]).images,
      });
      expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
      const runtimeUser = session.messages.find(
        (message) => Reflect.get(message, "idempotencyKey") === user.idempotencyKey,
      );
      expect(runtimeUser).toMatchObject({
        timestamp: user.timestamp,
        __openclaw: { ...user["__openclaw"], mediaImageBlockFactIndexes: [0] },
      });
      expect(manager.getBranch()[0]).toMatchObject({ message: user });
      const messages = streamMocks.streamSimple.mock.calls[0]![1].messages;
      expect(messages.filter((message: { role: string }) => message.role === "user")).toHaveLength(
        1,
      );
      expect(
        messages.flatMap((message: { content: unknown }) =>
          Array.isArray(message.content) ? message.content : [],
        ),
      ).toContainEqual(image);
    } finally {
      session.dispose();
    }
  });

  it.each([false, true])(
    "hydrates one current user through the built-in owner with interruption %s",
    async (interrupted) => {
      await withInterruptedTurn(
        false,
        async (fixture) => {
          const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
          const before = loadTranscriptEventsSync(fixture.target);
          await withReplaySession(
            fixture,
            false,
            async (session, submit) => {
              streamMocks.streamSimple.mockImplementation((model) =>
                createAssistantResultStream(
                  createAssistant(model, [{ type: "text", text: "Image turn recovered" }]),
                ),
              );
              await submit();
              expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
              const messages = streamMocks.streamSimple.mock.calls[0]![1].messages;
              const users = messages.filter(
                (message: { role: string; content: unknown }) =>
                  message.role === "user" &&
                  JSON.stringify(message.content).includes(fixture.attempt.prompt),
              );
              expect(users).toHaveLength(1);
              expect(users[0].content).toContainEqual(image);
              expect(loadTranscriptEventsSync(fixture.target).slice(0, before.length)).toEqual(
                before,
              );
              expect(
                SessionManager.open(fixture.target)
                  .getBranch()
                  .filter((entry) => entry.type === "message" && entry.message.role === "user"),
              ).toHaveLength(1);
              expect(session.getLastAssistantText()).toBe("Image turn recovered");
            },
            { images: finalizeRuntimePromptImages([{ image, factIndex: 0 }]).images },
          );
        },
        { interruptedTurn: interrupted },
      );
    },
  );

  it("preserves an existing user/carrier reasoning prefix during SDK replay", async () => {
    const manager = SessionManager.inMemory();
    const user = {
      role: "user" as const,
      content: "Original request",
      timestamp: 1,
      idempotencyKey: "carrier-turn:user",
    };
    manager.appendMessage(user);
    const carrier = buildRuntimeContextCustomMessage("Original runtime context")!;
    manager.appendCustomMessageEntry(
      carrier.customType,
      carrier.content,
      carrier.display,
      carrier.details,
    );
    manager.appendMessage(
      createAssistant(
        testModel,
        [
          {
            type: "thinking",
            thinking: "Original reasoning",
            thinkingSignature: "synthetic-signature",
          },
        ],
        "aborted",
      ),
    );
    const { session } = await createTestSession({ sessionManager: manager });
    const before = structuredClone(session.messages);
    const providerPrefix = await session.agent.convertToLlm(before);
    streamMocks.streamSimple.mockImplementation((model) =>
      createAssistantResultStream(createAssistant(model, [{ type: "text", text: "Continued" }])),
    );
    try {
      await session.prompt("Rebuilt prompt", {
        persistedUserIdempotencyKey: user.idempotencyKey,
        images: [{ type: "image", data: "bmV3", mimeType: "image/png" }],
      });
      expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
      expect(
        streamMocks.streamSimple.mock.calls[0]![1].messages.slice(0, providerPrefix.length),
      ).toEqual(providerPrefix);
      expect(session.messages.slice(0, before.length)).toEqual(before);
    } finally {
      session.dispose();
    }
  });

  it("hands the opened manager to cleanup when replay preparation loses its writer", async () => {
    await withInterruptedTurn(false, async (fixture) => {
      let owner: SessionManager | undefined;
      let cleanupOwner: unknown;
      fixture.revoke();
      try {
        await expect(
          fixture.prepare((manager) => {
            owner = manager;
          }),
        ).rejects.toThrow("original writer closed");
      } finally {
        await cleanupEmbeddedAttemptResources({
          sessionManager: owner,
          flushPendingToolResultsAfterIdle: async ({ sessionManager }) => {
            cleanupOwner = sessionManager;
          },
        });
      }
      expect(cleanupOwner).toBeInstanceOf(SessionManager);
      expect(owner?.getSessionId()).toBe(fixture.target.sessionId);
    });
  });

  it.each(["partial", "final", "other-run", "coded-abort"] as const)(
    "does not promote a %s tail into replay authority",
    async (tail) => {
      await withInterruptedTurn(false, async (fixture) => {
        const original = guardSessionManager(SessionManager.open(fixture.target), {
          runId: tail === "other-run" ? "unrelated-run" : fixture.attempt.runId,
        });
        const message = createFailureMessage(testModel, createAgentRunRestartAbortError(), true);
        if (tail === "partial") {
          message.content = [{ type: "text", text: "partial response" }];
        } else if (tail === "final") {
          message.stopReason = "stop";
          message.content = [{ type: "text", text: "NO_REPLY" }];
        } else if (tail === "coded-abort") {
          Object.assign(message, { errorCode: "OPENCLAW_DIRECT_ABORT" });
        }
        original.appendMessage(message);
        await withReplaySession(fixture, false, async (_session, submit) => {
          await submit();
          expect(streamMocks.streamSimple).not.toHaveBeenCalled();
          expect(fixture.attempt.userTurnTranscriptRecorder!.hasPersisted()).toBe(false);
        });
      });
    },
  );

  it.each(["other-run", "final", "hidden-user", "unknown-activity"] as const)(
    "does not resume tool work across %s transcript entries",
    async (boundary) => {
      await withInterruptedTurn(false, async (fixture) => {
        const original = SessionManager.open(fixture.target);
        if (boundary === "final") {
          guardSessionManager(original, { runId: fixture.attempt.runId }).appendMessage(
            createAssistant(testModel, [{ type: "text", text: "Already finished" }]),
          );
        }
        appendCompletedToolWork(
          original,
          boundary === "other-run" ? "unrelated-run" : fixture.attempt.runId,
          () => {
            // This row and the nested activity share one omitted context link.
            if (boundary === "hidden-user") {
              const hiddenUser: PersistedUserTurnMessage = {
                role: "user",
                content: "A newer hidden user request",
                excludeFromContext: true,
                timestamp: 2,
              };
              original.appendMessage(hiddenUser);
            } else if (boundary === "unknown-activity") {
              original.appendMessage({
                role: "custom",
                customType: "unidentified-activity",
                content: "Unknown context must close the replay",
                display: false,
                excludeFromContext: true,
                timestamp: 2,
              });
            }
          },
        );
        appendOversizedCacheSnapshot(original);
        await withReplaySession(fixture, false, async (_session, submit) => {
          await submit();
          expect(streamMocks.streamSimple).not.toHaveBeenCalled();
          expect(fixture.attempt.userTurnTranscriptRecorder!.hasPersisted()).toBe(false);
        });
      });
    },
  );

  it.each([
    { ordering: "repeated-restart", appendOnly: false },
    { ordering: "repeated-restart", appendOnly: true },
    { ordering: "pre-core-compaction", appendOnly: false },
    { ordering: "pre-core-compaction", appendOnly: true },
  ])(
    "replays the same interrupted turn after $ordering with append-only context $appendOnly",
    async ({ ordering, appendOnly }) => {
      await withInterruptedTurn(appendOnly, async (fixture) => {
        if (ordering === "repeated-restart") {
          const previous = guardSessionManager(SessionManager.open(fixture.target), {
            runId: fixture.attempt.runId,
          });
          previous.appendMessage(
            createFailureMessage(testModel, createAgentRunRestartAbortError(), true),
          );
        }
        let activeSession: AgentSession;
        await withReplaySession(
          fixture,
          appendOnly,
          async (session, submit) => {
            activeSession = session;
            streamMocks.streamSimple.mockImplementation((model) =>
              createAssistantResultStream(
                createAssistant(model, [{ type: "text", text: "Recovered same turn" }]),
              ),
            );
            await submit();
            expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
            expect(session.getLastAssistantText()).toBe("Recovered same turn");
          },
          ordering === "pre-core-compaction"
            ? {
                recovery: "compaction",
                beforeStart: async () => {
                  await activeSession.compact();
                },
              }
            : {},
        );
      });
    },
  );

  it.each(
    (
      [
        "later-user",
        "excluded-user",
        "excluded-user-with-tail",
        "final",
        "reset",
        "branch",
        "writer",
        "lifecycle",
        "session",
        "closed",
      ] as const
    ).flatMap((change) => [
      { change, phase: "SDK hooks" as const },
      { change, phase: "prepared replay" as const },
    ]),
  )("refuses a replay after $change changes during $phase", async ({ change, phase }) => {
    await withInterruptedTurn(false, async (fixture) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      await withReplaySession(
        fixture,
        false,
        async (_session, submit) => {
          const settled = Promise.allSettled([submit()]);
          await Promise.race([
            entered.promise,
            settled.then(() => {
              throw new Error("Replay settled before the mutation barrier");
            }),
          ]);
          const other = SessionManager.open(fixture.target);
          if (change === "later-user" || change.startsWith("excluded-user")) {
            const laterUser = {
              role: "user" as const,
              content: "new request",
              timestamp: 2,
              ...(change.startsWith("excluded-user") ? { excludeFromContext: true as const } : {}),
            };
            other.appendMessage(laterUser);
            if (change === "excluded-user-with-tail") {
              guardSessionManager(other, { runId: fixture.attempt.runId }).appendMessage(
                createFailureMessage(testModel, createAgentRunRestartAbortError(), true),
              );
            }
          }
          if (change === "final") {
            other.appendMessage(
              createAssistant(testModel, [{ type: "text", text: "already done" }]),
            );
          }
          if (change === "reset") {
            other.appendResetBoundary("reset");
          }
          if (change === "branch") {
            other.appendLeafControl({ targetId: null, appendParentId: null });
          }
          if (change === "writer" || change === "session" || change === "lifecycle") {
            await upsertSessionEntryCore(fixture.target, {
              sessionId: change === "session" ? "replacement-session" : fixture.target.sessionId,
              updatedAt: 2,
              activeWriterRunId:
                change === "lifecycle" ? fixture.attempt.runId : "replacement-writer",
              ...(change === "lifecycle" ? { lifecycleRevision: "replacement-generation" } : {}),
            });
          }
          if (change === "closed") {
            fixture.revoke();
          }
          const before = loadTranscriptEventsSync(fixture.target);
          release.resolve();
          expect((await settled)[0]?.status).toBe("rejected");
          expect(streamMocks.streamSimple).not.toHaveBeenCalled();
          expect(loadTranscriptEventsSync(fixture.target)).toEqual(before);
        },
        phase === "SDK hooks"
          ? {
              beforeStart: async () => {
                entered.resolve();
                await release.promise;
              },
            }
          : {
              afterReplayPreparation: async () => {
                entered.resolve();
                await release.promise;
              },
            },
      );
    });
  });

  it.each(["retry", "compaction"] as const)(
    "consumes replay validation before this run writes and internally resumes after %s",
    async (recovery) => {
      await withInterruptedTurn(false, async (fixture) => {
        await withReplaySession(
          fixture,
          false,
          async (session, submit) => {
            streamMocks.streamSimple.mockImplementationOnce((model) =>
              createAssistantResultStream(
                recovery === "compaction"
                  ? createOverflowAssistant(model)
                  : {
                      ...createAssistant(model, [], "error"),
                      errorMessage: "503 overloaded",
                    },
              ),
            );
            streamMocks.streamSimple.mockImplementation((model) =>
              createAssistantResultStream(
                createAssistant(model, [{ type: "text", text: "Recovered after retry" }]),
              ),
            );
            await submit();
            expect(streamMocks.streamSimple).toHaveBeenCalledTimes(2);
            expect(session.getLastAssistantText()).toBe("Recovered after retry");
          },
          { recovery },
        );
      });
    },
  );
});

it.each([
  { kind: "source snapshot", detached: true, fresh: false, explicit: undefined },
  { kind: "fresh helper", detached: true, fresh: true, explicit: undefined },
  { kind: "explicit override", detached: true, fresh: false, explicit: "caller-cache-key" },
  { kind: "durable sibling", detached: false, fresh: false, explicit: undefined },
])(
  "derives boundary cache affinity from the prompt owner ($kind)",
  async ({ detached, fresh, explicit }) => {
    await withInterruptedTurn(
      false,
      async ({ attempt, target, prepare }) => {
        const durable = SessionManager.open(target, attempt.workspaceDir);
        const manager = !detached
          ? durable
          : fresh
            ? SessionManager.inMemory(attempt.workspaceDir)
            : SessionManager.fromEntries(
                [durable.getHeader(), ...durable.getBranch()],
                attempt.workspaceDir,
              );
        attempt.sessionManager = manager;
        attempt.userTurnTranscriptRecorder = undefined;
        attempt.sessionPersistence = detached ? "detached" : "durable";
        attempt.promptCacheKey = explicit;
        if (detached) {
          attempt.sessionId = "private-helper-routing-identity";
          attempt.sessionKey = "agent:main:internal-session-effects:cache-fixture";
          attempt.sessionTarget = {
            ...target,
            sessionId: attempt.sessionId,
            sessionKey: attempt.sessionKey,
          };
          attempt.sessionFile = attempt.sessionKey;
        }
        const expected = explicit ?? `${manager.getSessionId()}:${manager.getBoundaryCount()}`;
        const before = loadTranscriptEventsSync(target);
        await prepare();
        expect(attempt.promptCacheKey).toBe(expected);
        expect(loadTranscriptEventsSync(target)).toEqual(before);
      },
      { interruptedTurn: false },
    );
  },
);
