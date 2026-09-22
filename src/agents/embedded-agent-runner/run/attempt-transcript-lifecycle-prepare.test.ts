import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
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
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../../admitted-run-context.js";
import { createAssistantErrorTranscript } from "../../assistant-error-transcript.js";
import { installSessionToolResultGuard } from "../../session-tool-result-guard.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { rewriteTranscriptEntriesInSessionManager } from "../transcript-rewrite.js";
import { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import { preparePersistedCurrentUserTurn } from "./pre-persisted-user-turn.js";
import { claimAgentSessionWriter, prepareInitialSessionWriter } from "./session-bootstrap.js";
import { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";

const userMessage = { role: "user" as const, content: "First user turn", timestamp: 1 };

type InitialWriterFixture = {
  admission: PreparedAgentRunAdmission;
  controller: AbortController;
  manager: SessionManager;
  openManager: () => SessionManager;
  promptState: Awaited<ReturnType<typeof createEmbeddedRunSessionPromptState>>;
  replaceAdmission: () => Promise<void>;
  runParams: PreparedEmbeddedRunInput["runParams"];
  target: { agentId: string; sessionId: string; sessionKey: string; storePath: string };
  transcript: Awaited<ReturnType<typeof prepareEmbeddedAttemptTranscriptLifecycle>>;
};

async function withInitialWriter(
  run: (fixture: InitialWriterFixture) => Promise<void | (() => Promise<void>)>,
  options: { existing?: boolean; outsideTranscriptWrite?: boolean } = {},
) {
  await withOpenClawTestState({ label: "initial-session-writer" }, async (state) => {
    const sessionId = randomUUID();
    const runId = randomUUID();
    const target = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
    };
    const controller = new AbortController();
    const admission = prepareSystemAgentRunAdmission({}, runId, "main", "initial-writer-test");
    const admissions = [admission];
    let prepared: Awaited<ReturnType<typeof prepareEmbeddedAttemptTranscriptLifecycle>> | undefined;
    try {
      const runParams: PreparedEmbeddedRunInput["runParams"] = {
        admittedRunContext: await admission.admit("embedded"),
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
      const afterAttempt = await promptState.withSessionWriterContext(async () => {
        const transcript = await prepareEmbeddedAttemptTranscriptLifecycle({
          attempt: runParams,
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
      await runExclusiveSessionLifecycleMutation({
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
      await runExclusiveSessionLifecycleMutation({
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

  it.each([false, true])(
    "settles one terminal error after attempt teardown (existing=%s)",
    async (existing) => {
      await withInitialWriter(
        async ({ manager, promptState, runParams, target }) => {
          manager.appendMessage(userMessage);
          const owner = createAssistantErrorTranscript({ runId: runParams.runId });
          installSessionToolResultGuard(manager, { assistantErrorTranscript: owner });
          manager.appendMessage(makeAgentAssistantMessage({ content: [], stopReason: "error" }));
          expect(
            SessionManager.open(target)
              .getBranch()
              .filter((entry) => entry.type === "message"),
          ).toHaveLength(1);
          return async () => {
            await promptState[Symbol.asyncDispose]();
            await owner.settle(true);
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

  it.each([false, true])(
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
            preparePersistedCurrentUserTurn({
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

  it.each([false, true])(
    "retains the exact committed writer for later mutations (existing=%s)",
    async (existing) => {
      await withInitialWriter(
        async ({ manager, promptState, runParams, target }) => {
          expect(Boolean(promptState.sessionWriterFence)).toBe(existing);
          expect(isSessionWorkAdmissionActive(target.storePath, [target.sessionKey])).toBe(
            !existing,
          );
          manager.appendMessage(userMessage);
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
          expect(() =>
            runWithoutOwnedSessionTranscriptWrites(() => manager.appendMessage(userMessage)),
          ).toThrow(SessionTranscriptWriterClaimReboundError);
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
        expect(() => manager.appendMessage(userMessage)).toThrow(
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

  it("captures the committed claim before identity-observer cancellation stops the first transcript append", async () => {
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
        expect(() => manager.appendMessage(userMessage)).toThrow(callerError);
        expect(observedFence).toEqual({
          expectedLifecycleRevision: undefined,
          expectedWriterRunId: runParams.runId,
        });
        expect(promptState.sessionWriterFence).toEqual(observedFence);
        expect(loadSessionEntry(target)).toMatchObject({
          sessionId: target.sessionId,
          activeWriterRunId: runParams.runId,
        });
        expect(loadTranscriptEventsSync(target)).toEqual([]);
      } finally {
        unsubscribe();
      }
    });
  });

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
          expect(rewrite().changed).toBe(true);
          expect(SessionManager.open(target).getBranch()).toMatchObject([
            { type: "message", message: { content: "Rewritten user turn" } },
          ]);
        } else {
          expect(rewrite).toThrow();
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
