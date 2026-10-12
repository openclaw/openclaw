import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import { projectionLane } from "../../../config/sessions/session-transcript-worker-resources.js";
import { captureSessionTranscriptTargetBinding } from "../../../config/sessions/transcript-target-binding.js";
import {
  SessionTranscriptWriterClaimReboundError,
  runWithoutOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import { getAgentRunLifecycleGeneration } from "../../../infra/agent-run-registry.js";
import {
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../../sessions/session-lifecycle-admission.js";
import { onSessionIdentityMutation } from "../../../sessions/session-lifecycle-events.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { runOpenClawAgentWriteTransaction } from "../../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
  type PreparedAgentRunAdmission,
} from "../../admitted-run-context.js";
import { createAssistantErrorTranscript } from "../../assistant-error-transcript.js";
import { isRecordedModelFallbackStop } from "../../model-fallback-stop.js";
import { attachInternalToolResultAcknowledgement } from "../../runtime/internal-hooks.js";
import { installSessionToolResultGuard } from "../../session-tool-result-guard.js";
import { SessionMetadataCommittedError } from "../../sessions/session-manager-metadata-error.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { rewriteTranscriptEntriesInSessionManager } from "../transcript-rewrite.js";
import { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";
import { preparePersistedCurrentUserTurn } from "./pre-persisted-user-turn.js";
import { claimAgentSessionWriter, prepareInitialSessionWriter } from "./session-bootstrap.js";
import { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";

const userMessage = { role: "user" as const, content: "First user turn", timestamp: 1 };
const initialWriteKinds = ["message", "model", "thinking"] as const;
async function appendInitial(
  kind: (typeof initialWriteKinds)[number],
  manager: SessionManager,
): Promise<string> {
  return kind === "model"
    ? manager.appendModelChange("test-provider", "test-model")
    : kind === "thinking"
      ? manager.appendThinkingLevelChange("high")
      : manager.appendMessage(userMessage);
}

type InitialWriterFixture = {
  admission: PreparedAgentRunAdmission;
  controller: AbortController;
  manager: SessionManager;
  openManager: () => SessionManager;
  promptState: Awaited<ReturnType<typeof createEmbeddedRunSessionPromptState>>;
  preparedSessionTarget: NonNullable<EmbeddedRunAttemptInternalParams["preparedSessionTarget"]>;
  replaceAdmission: () => Promise<void>;
  runParams: PreparedEmbeddedRunInput["runParams"];
  target: { agentId: string; sessionId: string; sessionKey: string; storePath: string };
  transcript: Awaited<ReturnType<typeof prepareEmbeddedAttemptTranscriptLifecycle>>;
};

async function withInitialWriter(
  run: (fixture: InitialWriterFixture) => Promise<void | (() => Promise<void>)>,
  options: { existing?: boolean; outsideTranscriptWrite?: boolean; incognito?: boolean } = {},
) {
  await withOpenClawTestState({ label: "initial-session-writer" }, async (state) => {
    const sessionId = randomUUID();
    const runId = randomUUID();
    const target = {
      agentId: "main",
      sessionId,
      sessionKey: options.incognito
        ? `agent:main:dashboard:incognito-${sessionId}`
        : `agent:main:${sessionId}`,
      storePath: options.incognito
        ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env })
        : path.join(state.agentDir(), "openclaw-agent.sqlite"),
    };
    const controller = new AbortController();
    const admission = prepareSystemAgentRunAdmission({}, runId, "main", "initial-writer-test");
    const admissions = [admission];
    let prepared: Awaited<ReturnType<typeof prepareEmbeddedAttemptTranscriptLifecycle>> | undefined;
    try {
      const admittedRunContext = await admission.admit("embedded");
      const runParams: PreparedEmbeddedRunInput["runParams"] = {
        admittedRunContext,
        abortSignal: controller.signal,
        agentId: target.agentId,
        sessionId,
        sessionKey: target.sessionKey,
        sessionFile: target.sessionKey,
        sessionTarget: target,
        workspaceDir: state.workspaceDir,
        prompt: "hello",
        timeoutMs: 30_000,
        runId,
      };
      if (options.existing) {
        replaceSessionEntrySync(target, {
          sessionId,
          updatedAt: 1,
          lifecycleRevision: "existing-revision",
          ...(options.incognito ? { incognito: true } : {}),
        });
        const claim = await claimAgentSessionWriter(runParams);
        expect(claim?.expectedWriterRunId).toBe(runId);
        runParams.sessionTarget = { ...target, ...claim };
      }
      await using promptState = await createEmbeddedRunSessionPromptState({
        runParams,
        sessionAgentId: target.agentId,
        resolvedSessionKey: target.sessionKey,
        lifecycleGeneration: getAgentRunLifecycleGeneration(),
        onInterrupt: (reason) => controller.abort(reason),
      });
      const externalAbortController = {
        arm: vi.fn(),
        throwIfFiredAfterPrepCleanup: async () => controller.signal.throwIfAborted(),
      };
      const assertCurrent = resolveAdmittedRunActiveAssertion(
        admittedRunContext,
        controller.signal,
      );
      if (!assertCurrent) {
        throw new Error("Expected active fixture admission");
      }
      const preparedSessionTarget = {
        target: captureSessionTranscriptTargetBinding({
          ...target,
          ...promptState.sessionWriterFence,
        }),
        assertCurrent,
      };
      const afterAttempt = await promptState.withSessionWriterContext(async () => {
        const transcript = await prepareEmbeddedAttemptTranscriptLifecycle({
          attempt: { ...runParams, preparedSessionTarget },
          externalAbortController,
        });
        prepared = transcript;
        const openManager = () =>
          SessionManager.open({ ...target, ...promptState.sessionWriterFence }, state.workspaceDir);
        const runFixture = () =>
          run({
            admission,
            controller,
            manager: openManager(),
            openManager,
            promptState,
            preparedSessionTarget,
            replaceAdmission: async () => {
              const replacement = prepareSystemAgentRunAdmission(
                {},
                runId,
                "main",
                "replacement-test",
              );
              admissions.push(replacement);
              await replacement.admit("embedded");
            },
            runParams,
            target,
            transcript,
          });
        return options.outsideTranscriptWrite
          ? runFixture()
          : transcript.withOwnedTranscriptWrite(runFixture);
      });
      await prepared?.transcriptLifecycle.dispose();
      await afterAttempt?.();
      expect(externalAbortController.arm).toHaveBeenCalledOnce();
    } finally {
      try {
        await prepared?.transcriptLifecycle.dispose();
        expect(isSessionWorkAdmissionActive(target.storePath, [target.sessionKey])).toBe(false);
      } finally {
        for (const owner of admissions) {
          owner.close();
        }
      }
    }
  });
}

describe("admitted lazy session writer", () => {
  it.each([
    { existing: false, incognito: false },
    { existing: true, incognito: false },
  ])(
    "commits actor appends without pre-reads and refuses a replaced writer (existing=$existing, incognito=$incognito)",
    async ({ existing, incognito }) => {
      await withInitialWriter(
        async ({ manager, runParams, target, transcript }) => {
          const actor = transcript.ownedTranscriptWriteContext.sessionActor!.actor;
          const read = vi.spyOn(actor, "read");
          try {
            const first = manager.appendMessageAsync(userMessage);
            const second = manager.appendMessageAsync({
              role: "toolResult",
              toolCallId: "actor-result",
              toolName: "lookup",
              content: [{ type: "text", text: "Durable synthetic result" }],
              isError: false,
              timestamp: 2,
            });
            const [firstId, secondId] = await Promise.all([first, second]);
            const otherSessionId = `${target.sessionId}-other`;
            runWithoutOwnedSessionTranscriptWrites(() =>
              replaceSessionEntrySync(
                {
                  agentId: target.agentId,
                  storePath: target.storePath,
                  sessionKey: `${target.sessionKey}-other`,
                },
                { sessionId: otherSessionId, updatedAt: 2, ...(incognito && { incognito: true }) },
              ),
            );
            const thirdId = await manager.appendCustomEntryAsync("after-unrelated-write");
            const persisted = loadTranscriptEventsSync(target);
            expect(persisted.slice(-3)).toMatchObject([
              { id: firstId, message: userMessage },
              { id: secondId, parentId: firstId, message: { role: "toolResult" } },
              { id: thirdId, parentId: secondId, customType: "after-unrelated-write" },
            ]);
            expect(manager.getPersistedEntries()).toEqual(persisted);
            await claimAgentSessionWriter({ ...runParams, runId: "replacement-actor-writer" });
            await expect(manager.appendMessageAsync(userMessage)).rejects.toThrow(
              SessionTranscriptWriterClaimReboundError,
            );
            expect(loadTranscriptEventsSync(target)).toEqual(persisted);
            expect(read).not.toHaveBeenCalled();
          } finally {
            read.mockRestore();
          }
        },
        { existing, incognito },
      );
    },
  );

  it.each([false, true])(
    "acknowledges only persisted tool results (incognito=%s)",
    async (incognito) => {
      await withInitialWriter(
        async ({ manager, runParams, target, transcript }) => {
          if (incognito) {
            expect(transcript.ownedTranscriptWriteContext.sessionActor).toBeUndefined();
          }
          await manager.appendMessageAsync(userMessage);
          installSessionToolResultGuard(manager);
          const toolCall = (id: string) =>
            makeAgentAssistantMessage({
              content: [{ type: "toolCall", id, name: "lookup", arguments: {} }],
            });
          await manager.appendMessageAsync(toolCall("committed-result"));
          const acknowledge = vi.fn(() => {
            expect(loadTranscriptEventsSync(target).at(-1)).toMatchObject({
              type: "message",
              message: { role: "toolResult", toolCallId: "committed-result" },
            });
          });
          await manager.appendMessageAsync(
            attachInternalToolResultAcknowledgement(
              makeTextToolResult(
                "committed-result",
                "lookup",
                "persist before acknowledge",
                false,
                3,
              ),
              acknowledge,
            ),
          );
          expect(acknowledge).toHaveBeenCalledOnce();

          await manager.appendMessageAsync(toolCall("refused-result"));
          const before = loadTranscriptEventsSync(target);
          await claimAgentSessionWriter({ ...runParams, runId: "replacement-result-writer" });
          const refusedAcknowledgement = vi.fn();
          await expect(
            manager.appendMessageAsync(
              attachInternalToolResultAcknowledgement(
                makeTextToolResult("refused-result", "lookup", "must not acknowledge", false, 5),
                refusedAcknowledgement,
              ),
            ),
          ).rejects.toThrow(SessionTranscriptWriterClaimReboundError);
          expect(refusedAcknowledgement).not.toHaveBeenCalled();
          expect(loadTranscriptEventsSync(target)).toEqual(before);
        },
        { existing: true, incognito },
      );
    },
  );

  it("keeps an atomic first append committed when publication revokes its run", async () => {
    await withInitialWriter(async ({ controller, manager, promptState, target }) => {
      const failure = new Error("revoke after actor commit");
      const unsubscribe = onSessionIdentityMutation((event) => {
        if (event.kind === "create" && event.current.sessionId === target.sessionId) {
          controller.abort(failure);
        }
      });
      try {
        await expect(manager.appendMessageAsync(userMessage)).rejects.toThrow();
        expect(promptState.sessionWriterFence).toBeDefined();
        expect(loadTranscriptEventsSync(target)).toMatchObject([
          { type: "session" },
          { type: "message", message: userMessage },
        ]);
      } finally {
        unsubscribe();
      }
    });
  });

  it("does not replay an actor append whose outcome is unknown", async () => {
    await withInitialWriter(async ({ manager, target, transcript }) => {
      await manager.appendMessageAsync(userMessage);
      const before = loadTranscriptEventsSync(target);
      const actor = transcript.ownedTranscriptWriteContext.sessionActor!.actor;
      const append = vi
        .spyOn(actor, "appendTranscriptEvent")
        .mockImplementation(async (command) => ({
          kind: "unknown",
          target: actor.target,
          commandId: command.commandId,
          error: { name: "Error", message: "Synthetic lost worker outcome" },
        }));
      try {
        const failure = await manager
          .appendMessageAsync(userMessage)
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect(isRecordedModelFallbackStop(failure)).toBe(true);
        expect(append).toHaveBeenCalledOnce();
        expect(loadTranscriptEventsSync(target)).toEqual(before);
      } finally {
        append.mockRestore();
      }
    });
  });

  it.each([false])(
    "uses a stale-version postimage once without replaying a durable append (incognito=%s)",
    async (incognito) => {
      await withInitialWriter(
        async ({ manager, target, transcript }) => {
          await manager.appendMessageAsync(userMessage);
          const before = loadTranscriptEventsSync(target);
          const actor = transcript.ownedTranscriptWriteContext.sessionActor!.actor;
          const append = actor.appendTranscriptEvent.bind(actor);
          const stale = vi
            .spyOn(actor, "appendTranscriptEvent")
            .mockImplementationOnce((command, authority, observer) =>
              append(
                { ...command, expected: { epoch: "superseded-test-epoch", sequence: 0 } },
                authority,
                observer,
              ),
            );
          const read = vi.spyOn(actor, "read");
          try {
            const id = await manager.appendCustomEntryAsync("after-stale-version");
            expect(stale).toHaveBeenCalledTimes(2);
            expect(read).not.toHaveBeenCalled();
            const persisted = loadTranscriptEventsSync(target);
            expect(persisted.slice(0, before.length)).toEqual(before);
            expect(persisted.slice(before.length)).toMatchObject([
              { id, customType: "after-stale-version" },
            ]);
          } finally {
            stale.mockRestore();
            read.mockRestore();
          }
        },
        { existing: true, incognito },
      );
    },
  );

  it("refuses a prepared target whose owner closes during lifecycle preparation", async () => {
    await withInitialWriter(
      async ({ admission, preparedSessionTarget, runParams }) => {
        const arm = vi.fn();
        await expect(
          prepareEmbeddedAttemptTranscriptLifecycle({
            attempt: { ...runParams, preparedSessionTarget },
            externalAbortController: {
              arm,
              throwIfFiredAfterPrepCleanup: async () => admission.close(),
            },
          }),
        ).rejects.toThrow("admitted run authority is no longer active");
        expect(arm).not.toHaveBeenCalled();
      },
      { existing: true },
    );
  });

  it("retains its prepared target after managed replacement and refuses successor writes", async () => {
    await withInitialWriter(
      async ({ manager, preparedSessionTarget, runParams, target }) => {
        await manager.appendMessageAsync(userMessage);
        const replacement = {
          ...target,
          sessionId: "replacement-session",
        };
        runWithoutOwnedSessionTranscriptWrites(() =>
          replaceSessionEntrySync(replacement, { sessionId: replacement.sessionId, updatedAt: 2 }),
        );
        const before = loadTranscriptEventsSync(target);
        const replacementBefore = loadTranscriptEventsSync(replacement);
        const runRequest = projectionLane.pool.run.bind(projectionLane.pool);
        let runtimeTargets = 0;
        const requests = vi
          .spyOn(projectionLane.pool, "run")
          .mockImplementation(async (...args) => {
            const reply = await runRequest(...args);
            if (
              reply.ok &&
              typeof reply.value === "object" &&
              reply.value !== null &&
              "kind" in reply.value &&
              reply.value.kind === "session-runtime-target"
            ) {
              runtimeTargets++;
            }
            return reply;
          });
        let rebound:
          | Awaited<ReturnType<typeof prepareEmbeddedAttemptTranscriptLifecycle>>
          | undefined;
        try {
          rebound = await prepareEmbeddedAttemptTranscriptLifecycle({
            attempt: { ...runParams, preparedSessionTarget },
            externalAbortController: {
              arm: () => {},
              throwIfFiredAfterPrepCleanup: async () => {},
            },
          });
          expect(rebound.ownedTranscriptWriteContext.sessionTarget).toMatchObject(target);
          expect(runtimeTargets).toBe(0);
          await expect(
            rebound.withOwnedTranscriptWrite(() => manager.appendMessageAsync(userMessage)),
          ).rejects.toThrow();
          expect(loadTranscriptEventsSync(target)).toEqual(before);
          expect(loadTranscriptEventsSync(replacement)).toEqual(replacementBefore);
        } finally {
          await rebound?.transcriptLifecycle.dispose();
          requests.mockRestore();
        }
      },
      { existing: true },
    );
  });

  it("retains uncommitted custody beyond bounded teardown without aborting accepted writes", async () => {
    await withInitialWriter(
      async ({ promptState, transcript, manager, target }) => {
        const entered = createDeferredCore();
        const gate = createDeferredCore();
        const write = transcript.withOwnedTranscriptWrite(async () => {
          entered.resolve();
          await gate.promise;
          manager.appendMessage(userMessage);
        });
        await entered.promise;
        vi.useFakeTimers();
        let closing: Promise<void | undefined> | undefined;
        try {
          const dispose = transcript.transcriptLifecycle.dispose();
          await vi.advanceTimersByTimeAsync(30_000);
          await dispose;
          let closed = false;
          closing = promptState[Symbol.asyncDispose]().then(() => {
            closed = true;
          });
          await Promise.resolve();
          expect(closed).toBe(false);
          expect(isSessionWorkAdmissionActive(target.storePath, [target.sessionKey])).toBe(true);
          expect(loadSessionEntry(target)).toBeUndefined();
          gate.resolve();
          await write;
          await closing;
          expect(isSessionWorkAdmissionActive(target.storePath, [target.sessionKey])).toBe(false);
          expect(loadSessionEntry(target)?.sessionId).toBe(target.sessionId);
        } finally {
          gate.resolve();
          await Promise.allSettled([write, closing]);
          vi.useRealTimers();
        }
      },
      { outsideTranscriptWrite: true },
    );
  });

  it("keeps its uncommitted creator visible inside a same-key lifecycle mutation", async () => {
    await withInitialWriter(async ({ target }) => {
      await runExclusiveSessionLifecycleMutation("create", {
        scope: target.storePath,
        identities: [target.sessionKey],
        prepare: async () => {
          expect(isSessionWorkAdmissionActive(target.storePath, [target.sessionKey])).toBe(true);
        },
        run: async () => {
          expect(loadSessionEntry(target)).toBeUndefined();
        },
      });
    });
  });

  it("rejects an existing row before reacquiring its enclosing lifecycle mutation", async () => {
    await withInitialWriter(async ({ manager, runParams, target }) => {
      manager.appendMessage(userMessage);
      await runExclusiveSessionLifecycleMutation("create", {
        scope: target.storePath,
        identities: [target.sessionKey],
        run: async () => {
          await expect(
            prepareInitialSessionWriter({ runParams, target, onInterrupt: () => {} }),
          ).rejects.toThrow(SessionTranscriptWriterClaimReboundError);
        },
      });
    });
  });

  it.each([false])(
    "preserves one committed terminal error through attempt teardown (existing=%s)",
    async (existing) => {
      await withInitialWriter(
        async ({ manager, promptState, target }) => {
          manager.appendMessage(userMessage);
          const owner = createAssistantErrorTranscript();
          installSessionToolResultGuard(manager, { assistantErrorTranscript: owner });
          manager.appendMessage(makeAgentAssistantMessage({ content: [], stopReason: "error" }));
          expect(
            SessionManager.open(target)
              .getBranch()
              .filter((entry) => entry.type === "message"),
          ).toHaveLength(2);
          return async () => {
            await promptState[Symbol.asyncDispose]();
            owner.settle(true);
            expect(
              SessionManager.open(target)
                .getBranch()
                .filter((entry) => entry.type === "message"),
            ).toHaveLength(2);
          };
        },
        { existing },
      );
    },
  );

  it.each([false])(
    "prepares a fresh keyed turn before its first append (existing=%s)",
    async (existing) => {
      await withInitialWriter(
        async ({ manager, runParams, target }) => {
          const message = { ...userMessage, idempotencyKey: `${runParams.runId}:user` };
          const recorder = createUserTurnTranscriptRecorder({
            message,
            target: { ...target, sessionEntry: undefined },
          });
          expect(Boolean(loadSessionEntry(target))).toBe(existing);
          expect(
            await preparePersistedCurrentUserTurn({
              sessionManager: manager,
              message,
              recorder,
              runId: runParams.runId,
            }),
          ).toBeUndefined();
          manager.appendMessage(message);
          expect(loadSessionEntry(target)).toMatchObject({
            sessionId: target.sessionId,
            activeWriterRunId: runParams.runId,
          });
          expect(
            SessionManager.open(target)
              .getBranch()
              .filter((entry) => entry.type === "message" && entry.message.role === "user"),
          ).toHaveLength(1);
        },
        { existing },
      );
    },
  );

  it.each([
    { existing: false, kind: "message" },
    { existing: false, kind: "model" },
    { existing: false, kind: "thinking" },
    { existing: true, kind: "message" },
  ] as const)(
    "retains the exact committed writer for later mutations (existing=$existing initial=$kind)",
    async ({ existing, kind }) => {
      await withInitialWriter(
        async ({ manager, promptState, runParams, target }) => {
          expect(Boolean(promptState.sessionWriterFence)).toBe(existing);
          expect(isSessionWorkAdmissionActive(target.storePath, [target.sessionKey])).toBe(
            !existing,
          );
          await appendInitial(kind, manager);
          const entry = loadSessionEntry({ ...target, readConsistency: "latest" });
          expect(entry).toMatchObject({
            sessionId: target.sessionId,
            activeWriterRunId: runParams.runId,
          });
          const expectedFence = {
            expectedLifecycleRevision: existing ? "existing-revision" : undefined,
            expectedWriterRunId: runParams.runId,
          };
          expect(promptState.sessionWriterFence).toEqual(expectedFence);
          expect(isSessionWorkAdmissionActive(target.storePath, [target.sessionKey])).toBe(false);
          expect(manager.getSessionTarget()).toMatchObject(expectedFence);
          manager.appendMessage(userMessage);
          expect(loadTranscriptEventsSync(target)).toHaveLength(3);
          await claimAgentSessionWriter({ ...runParams, runId: "new-writer" });
          const before = loadTranscriptEventsSync(target);
          await expect(
            runWithoutOwnedSessionTranscriptWrites(() => appendInitial(kind, manager)),
          ).rejects.toThrow(SessionTranscriptWriterClaimReboundError);
          expect(loadTranscriptEventsSync(target)).toEqual(before);
          expect(loadSessionEntry(target)).toMatchObject({ activeWriterRunId: "new-writer" });
        },
        { existing },
      );
    },
  );

  it.each(["abort", "closed", "replaced"] as const)(
    "does not create a row when the original owner is %s",
    async (loss) => {
      await withInitialWriter(
        async ({ admission, controller, manager, promptState, replaceAdmission, target }) => {
          const callerError = new Error("caller cancelled before initial persistence");
          if (loss === "abort") {
            controller.abort(callerError);
          }
          if (loss === "closed") {
            admission.close();
          }
          if (loss === "replaced") {
            await replaceAdmission();
          }
          if (loss === "abort") {
            expect(() => manager.appendMessage(userMessage)).toThrow(callerError);
          } else {
            expect(() => manager.appendMessage(userMessage)).toThrow(
              "admitted run authority is no longer active",
            );
          }
          expect(promptState.sessionWriterFence).toBeUndefined();
          expect(loadSessionEntry(target)).toBeUndefined();
          expect(loadTranscriptEventsSync(target)).toEqual([]);
        },
      );
    },
  );

  it.each(["same-session", "copied-writer", "other-session"] as const)(
    "rejects a competing first row without adopting its %s identity",
    async (kind) => {
      await withInitialWriter(async ({ manager, promptState, runParams, target }) => {
        const competing: InternalSessionEntry = {
          sessionId: kind === "other-session" ? "competing-session" : target.sessionId,
          updatedAt: 7,
          ...(kind === "copied-writer" ? { activeWriterRunId: runParams.runId } : {}),
        };
        runWithoutOwnedSessionTranscriptWrites(() => replaceSessionEntrySync(target, competing));
        const before = loadSessionEntry(target);
        await expect(appendInitial("message", manager)).rejects.toThrow(
          SessionTranscriptWriterClaimReboundError,
        );
        expect(promptState.sessionWriterFence).toBeUndefined();
        expect(isSessionWorkAdmissionActive(target.storePath, [target.sessionKey])).toBe(true);
        expect(loadSessionEntry(target)).toEqual(before);
        expect(loadTranscriptEventsSync(target)).toEqual([]);
      });
    },
  );

  it("publishes no initial claim or identity for a rolled-back outer transaction", async () => {
    await withInitialWriter(async ({ manager, openManager, promptState, runParams, target }) => {
      const rollback = new Error("roll back first persistence");
      const identities: unknown[] = [];
      const unsubscribe = onSessionIdentityMutation((event) => {
        if (event.kind === "create" && event.current.sessionId === target.sessionId) {
          identities.push(event);
        }
      });
      try {
        expect(() =>
          runOpenClawAgentWriteTransaction(
            () => {
              manager.appendMessage(userMessage);
              expect(promptState.sessionWriterFence).toBeUndefined();
              throw rollback;
            },
            { agentId: target.agentId, path: target.storePath },
          ),
        ).toThrow(rollback);
        expect(promptState.sessionWriterFence).toBeUndefined();
        expect(loadSessionEntry(target)).toBeUndefined();
        expect(loadTranscriptEventsSync(target)).toEqual([]);
        expect(identities).toEqual([]);
        expect(isSessionWorkAdmissionActive(target.storePath, [target.sessionKey])).toBe(true);

        openManager().appendMessage(userMessage);
        expect(promptState.sessionWriterFence?.expectedWriterRunId).toBe(runParams.runId);
        expect(loadSessionEntry(target)).toMatchObject({ activeWriterRunId: runParams.runId });
        expect(identities).toHaveLength(1);
      } finally {
        unsubscribe();
      }
    });
  });

  it.each(["message", "model"] as const)(
    "captures the committed claim before identity-observer cancellation stops the first %s append",
    async (kind) => {
      await withInitialWriter(async ({ controller, manager, promptState, runParams, target }) => {
        const callerError = new Error("caller cancelled from committed identity observer");
        let observedFence: typeof promptState.sessionWriterFence;
        const unsubscribe = onSessionIdentityMutation((event) => {
          if (event.kind !== "create" || event.current.sessionId !== target.sessionId) {
            return;
          }
          observedFence = promptState.sessionWriterFence;
          controller.abort(callerError);
        });
        try {
          const failure = await appendInitial(kind, manager).catch((error: unknown) => error);
          if (kind === "message") {
            expect(failure).toBe(callerError);
          } else {
            expect(failure).toBeInstanceOf(SessionMetadataCommittedError);
            expect(isRecordedModelFallbackStop(failure)).toBe(true);
          }
          expect(observedFence).toEqual({
            expectedLifecycleRevision: undefined,
            expectedWriterRunId: runParams.runId,
          });
          expect(promptState.sessionWriterFence).toEqual(observedFence);
          expect(loadSessionEntry(target)).toMatchObject({
            sessionId: target.sessionId,
            activeWriterRunId: runParams.runId,
          });
          const events = loadTranscriptEventsSync(target);
          if (kind === "message") {
            expect(events).toEqual([]);
          } else {
            expect(events).toMatchObject([
              { type: "session" },
              kind === "model"
                ? { type: "model_change", provider: "test-provider", modelId: "test-model" }
                : { type: "thinking_level_change", thinkingLevel: "high" },
            ]);
          }
        } finally {
          unsubscribe();
        }
      });
    },
  );

  it.each(["active", "closed", "replaced"] as const)(
    "uses the original manager admission for transcript rewrites (%s)",
    async (state) => {
      await withInitialWriter(async ({ admission, manager, replaceAdmission, target }) => {
        const entryId = manager.appendMessage(userMessage);
        const before = loadTranscriptEventsSync(target);
        if (state === "closed") {
          admission.close();
        } else if (state === "replaced") {
          await replaceAdmission();
        }
        const rewrite = () =>
          runWithoutOwnedSessionTranscriptWrites(() =>
            rewriteTranscriptEntriesInSessionManager({
              sessionManager: manager,
              replacements: [
                { entryId, message: { ...userMessage, content: "Rewritten user turn" } },
              ],
            }),
          );
        if (state === "active") {
          expect((await rewrite()).changed).toBe(true);
          expect(SessionManager.open(target).getBranch()).toMatchObject([
            { type: "message", message: { content: "Rewritten user turn" } },
          ]);
        } else {
          await expect(rewrite()).rejects.toThrow();
          expect(loadTranscriptEventsSync(target)).toEqual(before);
          expect(manager.getBranch()).toMatchObject([{ type: "message", message: userMessage }]);
        }
      });
    },
  );

  it.each(["append", "trim", "branch"] as const)(
    "does not let a retained manager %s after its initial admission closes",
    async (operation) => {
      await withInitialWriter(async ({ admission, manager, target }) => {
        const first = manager.appendMessage(userMessage);
        const before = loadTranscriptEventsSync(target);
        admission.close();
        if (operation === "branch") {
          await expect(
            runWithoutOwnedSessionTranscriptWrites(() => manager.createBranchedSession(first)),
          ).rejects.toThrow("admitted run authority is no longer active");
        } else {
          expect(() =>
            runWithoutOwnedSessionTranscriptWrites(() =>
              operation === "append"
                ? manager.appendMessage(userMessage)
                : manager.removeTrailingEntries(() => true),
            ),
          ).toThrow("admitted run authority is no longer active");
        }
        expect(loadTranscriptEventsSync(target)).toEqual(before);
        expect(loadSessionEntry(target)?.sessionId).toBe(target.sessionId);
      });
    },
  );

  it("retains its initial admission even before the first append", async () => {
    await withInitialWriter(async ({ admission, manager, target }) => {
      admission.close();
      expect(() =>
        runWithoutOwnedSessionTranscriptWrites(() => manager.appendMessage(userMessage)),
      ).toThrow("admitted run authority is no longer active");
      expect(loadTranscriptEventsSync(target)).toEqual([]);
      expect(loadSessionEntry(target)).toBeUndefined();
    });
  });
});
