import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { loadSessionEntryForAdmission } from "../../../config/sessions/session-accessor.sqlite-entry-admission.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import {
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
} from "../../../config/sessions/session-transcript-reconcile.js";
import { useReconcileWorkerObserver } from "../../../config/sessions/session-transcript-reconcile.test-support.js";
import type { SessionTranscriptReconcileWorkerMessage } from "../../../config/sessions/session-transcript-reconcile.worker.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import { MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL } from "../../../sessions/input-provenance.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import type { PersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.types.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { AgentMessage } from "../../runtime/index.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  appendSessionTranscriptNote,
  withSessionManagerWrite,
} from "../../sessions/session-manager-write-admission.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import {
  createActiveSession,
  createSessionManager,
} from "./attempt-session-boundary.test-support.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";

// mock-isolation: Observe the real transcript worker's ownership and handoff ordering.
vi.mock("node:worker_threads", async () =>
  (
    await import("../../../config/sessions/session-transcript-reconcile.test-support.js")
  ).createObservedWorkerThreads(),
);

const observer = useReconcileWorkerObserver();

async function withPersistedOrphanBoundary(
  options: {
    parent: boolean;
    metadata: boolean;
    detachLeaf?: boolean;
    restartRecovery?: boolean;
    suppressNextUserMessagePersistence?: boolean;
    idempotencyKey?: string;
    excludeFromContext?: boolean;
    selectedOwner?: boolean;
  },
  run: (fixture: {
    input: Parameters<typeof prepareEmbeddedAttemptSessionBoundary>[0];
    manager: ReturnType<typeof guardSessionManager>;
    orphanId: string;
    target: NonNullable<ReturnType<SessionManager["getSessionTarget"]>>;
    revoke: () => void;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "orphan-projection" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "orphan-projection",
      sessionKey: "agent:main:orphan-projection",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const seed = SessionManager.open(target, state.workspaceDir);
    if (options.parent) {
      await seed.appendModelChange("openai", "gpt-5.5");
    }
    const orphanId = seed.appendMessage({
      role: "user",
      content: "orphan wake",
      timestamp: 1,
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      ...(options.excludeFromContext ? { excludeFromContext: true } : {}),
      ...(options.detachLeaf
        ? { provenance: { kind: "inter_session", sourceTool: "subagent_announce" } }
        : {}),
    });
    if (options.metadata) {
      await seed.appendThinkingLevelChange("low");
      await seed.appendModelChange("openai", "gpt-5.5");
    }
    const manager = guardSessionManager(
      SessionManager.openBounded(target, {
        cwd: state.workspaceDir,
        maxBytes: 4096,
        maxEvents: 20,
      }),
      {
        runId: "orphan-projection",
        suppressNextUserMessagePersistence: options.suppressNextUserMessagePersistence,
      },
    );
    const { activeSession } = createActiveSession(manager.buildSessionContext().messages);
    let active = true;
    const execute = () =>
      run({
        input: {
          activeSession,
          attempt: {
            sessionId: target.sessionId,
            ...(options.restartRecovery
              ? {
                  inputProvenance: {
                    kind: "internal_system" as const,
                    sourceTool: MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL,
                  },
                }
              : {}),
            prompt: "new request",
            suppressNextUserMessagePersistence: options.suppressNextUserMessagePersistence,
          },
          getUserTranscriptContexts: () => undefined,
          isRawModelRun: false,
          preparedUserTurnMessage: undefined,
          sessionManager: manager,
          setActiveSessionSystemPrompt: vi.fn(),
        },
        manager,
        orphanId,
        target,
        revoke: () => {
          active = false;
        },
      });
    if (!options.selectedOwner) {
      await execute();
      return;
    }
    const selected = await loadSessionEntryForAdmission(target);
    if (!("kind" in selected.databaseClaim) || selected.databaseClaim.kind !== "worker") {
      throw new Error("Boundary fixture requires a selected worker reader");
    }
    try {
      await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: target,
          sessionReader: selected.databaseClaim.reader,
          assertCommitAllowed: () => {
            if (!active) {
              throw new SessionTranscriptWriterClaimReboundError();
            }
          },
          withTranscriptWrite: async (operation) => await operation(),
        },
        execute,
      );
    } finally {
      await selected.databaseClaim.release();
    }
  });
}

describe("prepareEmbeddedAttemptSessionBoundary orphan recovery", () => {
  it.each(["orphan", "current", "excluded"] as const)(
    "preserves speech finalized while orphan repair waits for write admission: %s",
    async (kind) => {
      const currentUser = kind !== "orphan";
      await withPersistedOrphanBoundary(
        {
          parent: true,
          metadata: false,
          ...(currentUser ? { idempotencyKey: "current-run:user" } : {}),
          excludeFromContext: kind === "excluded",
          selectedOwner: currentUser,
        },
        async ({ input, manager, target }) => {
          if (currentUser) {
            const message: PersistedUserTurnMessage = {
              role: "user",
              content: "orphan wake",
              timestamp: 1,
              idempotencyKey: "current-run:user",
              ...(kind === "excluded" ? { excludeFromContext: true } : {}),
            };
            const recorder = createUserTurnTranscriptRecorder({
              target: { ...target, sessionEntry: undefined },
              message,
            });
            await recorder.persistApproved({ updateMode: "none" });
            input.preparedUserTurnMessage = message;
            input.attempt.userTurnTranscriptRecorder = recorder;
          }
          const reload = vi.spyOn(manager, "reloadPersistedTranscriptAsync");
          const admitted = createDeferred();
          const release = createDeferred();
          const speech = {
            ...makeAssistantMessageFixture({
              content: [{ type: "text", text: "voice reply" }],
              stopReason: "stop",
              timestamp: 2,
            }),
            provenance: { kind: "realtime_voice" as const, sourceChannel: "talk" },
          };
          const writing = withSessionManagerWrite(manager, async () => {
            admitted.resolve();
            await release.promise;
            await appendSessionTranscriptNote(target, speech);
          });
          await admitted.promise;
          const preparing = prepareEmbeddedAttemptSessionBoundary(input);
          release.resolve();
          const [, boundary] = await Promise.all([writing, preparing]);

          expect(boundary.orphanRepair).toBeUndefined();
          expect(reload).toHaveBeenCalledTimes(currentUser ? 0 : 1);
          reload.mockRestore();
          const consult: PersistedUserTurnMessage = {
            role: "user",
            content: "consult request",
            idempotencyKey: "consult:user",
            timestamp: 3,
          };
          const appended = await manager.appendMessageWithTranscriptAnchorAsync(consult);
          expect(appended.anchor).toBeDefined();
          expect(manager.buildSessionContext().messages).toMatchObject([
            ...(kind === "excluded" ? [] : [{ role: "user", content: "orphan wake" }]),
            speech,
            consult,
          ]);
          expect(loadTranscriptEventsSync(target)).not.toEqual(
            expect.arrayContaining([expect.objectContaining({ type: "leaf" })]),
          );
        },
      );
    },
  );

  it.each(["aborted", "rebound-writer", "selected-aborted", "selected-revoked"] as const)(
    "does not persist orphan repair for an unavailable owner: %s",
    async (reason) => {
      const selectedOwner = reason.startsWith("selected-");
      await withPersistedOrphanBoundary(
        {
          parent: true,
          metadata: true,
          detachLeaf: true,
          selectedOwner,
          ...(selectedOwner ? { idempotencyKey: "current-run:user" } : {}),
        },
        async ({ input, manager, orphanId, target, revoke }) => {
          if (selectedOwner) {
            const entry = manager.getEntry(orphanId);
            if (entry?.type !== "message" || entry.message.role !== "user") {
              throw new Error("Expected the persisted current user");
            }
            const recorder = createUserTurnTranscriptRecorder({
              target: { ...target, sessionEntry: undefined },
              message: entry.message,
            });
            await recorder.persistApproved({ updateMode: "none" });
            input.preparedUserTurnMessage = entry.message;
            input.attempt.userTurnTranscriptRecorder = recorder;
          }
          const before = loadTranscriptEventsSync(target);
          const messages = input.activeSession.agent.state.messages;
          const invalidated = vi.fn();
          input.attempt.onUserMessagePersistenceInvalidated = invalidated;
          if (reason === "aborted" || reason === "selected-aborted") {
            input.abortSignal = AbortSignal.abort(new Error("cancel before repair"));
          }
          if (reason === "selected-revoked") {
            revoke();
          }
          const prepare = () => prepareEmbeddedAttemptSessionBoundary(input);
          const preparing =
            reason === "rebound-writer"
              ? withOwnedSessionTranscriptWrites(
                  {
                    sessionTarget: { ...target, expectedWriterRunId: "replaced-owner" },
                    withTranscriptWrite: async (operation) => await operation(),
                  },
                  prepare,
                )
              : prepare();
          await expect(preparing).rejects.toThrow(
            reason === "aborted" || reason === "selected-aborted"
              ? "cancel before repair"
              : SessionTranscriptWriterClaimReboundError,
          );
          expect(loadTranscriptEventsSync(target)).toEqual(before);
          expect(input.activeSession.agent.state.messages).toBe(messages);
          expect(invalidated).not.toHaveBeenCalled();
        },
      );
    },
  );

  it("cancels its projection wait before publishing repaired prompt state", async () => {
    await withPersistedOrphanBoundary(
      { parent: true, metadata: true, detachLeaf: true },
      async ({ input, target }) => {
        const claimed = createDeferred();
        const databaseOptions = toDatabaseOptions(resolveSqliteTranscriptScope(target));
        let releaseWorker: (() => void) | undefined;
        observer.onTask = ({ port, observeMessage }) => {
          const postMessage = port.postMessage.bind(port);
          let claiming = false;
          observeMessage((message: SessionTranscriptReconcileWorkerMessage) => {
            claiming = message.type === "plan-start" && message.plan.sessionId === target.sessionId;
          });
          // Hold the real worker after the owner claims the dirty projection.
          // No fixture sleeps or database mutation decides the ordering.
          port.postMessage = (message: unknown, transferList) => {
            const options = Array.isArray(transferList) ? { transfer: transferList } : transferList;
            if (claiming && !releaseWorker) {
              releaseWorker = () => postMessage(message, options);
              claimed.resolve();
              return;
            }
            postMessage(message, options);
          };
        };
        startSessionTranscriptIndexReconcile(databaseOptions);
        const controller = new AbortController();
        input.abortSignal = controller.signal;
        const messages = input.activeSession.agent.state.messages;
        const invalidated = vi.fn();
        input.attempt.onUserMessagePersistenceInvalidated = invalidated;
        const preparing = prepareEmbeddedAttemptSessionBoundary(input);
        const outcome = preparing.then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        );
        try {
          await Promise.race([
            claimed.promise,
            outcome.then(() => {
              throw new Error("repair settled before its projection was claimed");
            }),
          ]);
          const abortReason = new Error("cancel owned projection wait");
          controller.abort(abortReason);
          await expect(outcome).resolves.toMatchObject({
            kind: "rejected",
            error: { name: "AbortError", cause: abortReason },
          });
          expect(input.activeSession.agent.state.messages).toBe(messages);
          expect(invalidated).not.toHaveBeenCalled();
        } finally {
          releaseWorker?.();
          await Promise.all([outcome, waitForSessionTranscriptIndexReconcile(databaseOptions)]);
        }
      },
    );
  });

  it("keeps an excluded admitted user out of an internal retry's model input", async () => {
    await withPersistedOrphanBoundary(
      {
        parent: true,
        metadata: true,
        suppressNextUserMessagePersistence: true,
        excludeFromContext: true,
      },
      async ({ input, orphanId, target }) => {
        const before = loadTranscriptEventsSync(target);
        expect(before).toEqual(expect.arrayContaining([expect.objectContaining({ id: orphanId })]));
        Object.assign(input.attempt, { skipPreparedUserTurnMessage: true });
        const boundary = await prepareEmbeddedAttemptSessionBoundary(input);

        expect(boundary.orphanRepair).toBeUndefined();
        expect(input.activeSession.agent.state.messages).toEqual([]);
        expect(loadTranscriptEventsSync(target)).toEqual(before);
      },
    );
  });

  it.each([{ parent: false, metadata: true }])(
    "keeps the repaired orphan on the canonical branch for later turns: %j",
    async (options) => {
      await withPersistedOrphanBoundary(
        { ...options, restartRecovery: true, suppressNextUserMessagePersistence: true },
        async ({ input, manager, orphanId, target }) => {
          const boundary = await prepareEmbeddedAttemptSessionBoundary(input);
          expect(boundary.orphanRepair?.removeLeaf).toBe(false);
          expect(manager.getBranch().map((entry) => entry.id)).toContain(orphanId);
          const reopened = SessionManager.openBounded(target, { maxBytes: 4096, maxEvents: 20 });
          expect(reopened.getBranch().map((entry) => entry.id)).toContain(orphanId);
          expect(loadTranscriptEventsSync(target)).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: orphanId })]),
          );
          // This turn's assembled messages omit the orphan (folded into the prompt)
          // while the session tree still points at it for subsequent turns.
          expect(
            input.activeSession.agent.state.messages.some((message) => {
              const content = (message as { content?: unknown }).content;
              return content === "orphan wake" || JSON.stringify(content).includes("orphan wake");
            }),
          ).toBe(false);
          const leafBeforeAppend = manager.getLeafId();
          const appended = manager.appendMessageWithTranscriptAnchor(
            makeAssistantMessageFixture({
              content: [{ type: "text", text: "recovery reply" }],
              stopReason: "stop",
              timestamp: 2,
            }),
          );
          expect(manager.getEntry(appended.entryId)?.parentId).toBe(leafBeforeAppend);
          expect(manager.getBranch().map((entry) => entry.id)).toEqual(
            expect.arrayContaining([orphanId, appended.entryId]),
          );
        },
      );
    },
  );

  it.each([
    {
      name: "recorder state is lost on restart",
      prepared: true,
      recorded: false,
      persisted: false,
    },
  ])(
    "preserves the admitted current user when $name",
    async ({ prepared, recorded, persisted }) => {
      const currentUser = {
        role: "user" as const,
        content: "current prompt",
        idempotencyKey: "current-run:user",
        timestamp: 1,
      };
      const { activeSession } = createActiveSession([]);
      const branchAsync = vi.fn(async () => undefined);
      const resetLeafAsync = vi.fn(async () => undefined);
      const setNextUserMessagePersistence = vi.fn();
      const onUserMessagePersistenceInvalidated = vi.fn();
      const sessionManager = createSessionManager({
        branchAsync,
        resetLeafAsync,
        setNextUserMessagePersistence,
        getLeafEntry: () => ({
          id: "current-user",
          parentId: "previous-assistant",
          timestamp: "2026-07-13T00:00:00.000Z",
          type: "message",
          message: currentUser,
        }),
      });
      const recorder = {
        hasPersisted: () => persisted,
        ...(recorded ? { getPersistedMessage: () => currentUser } : {}),
      } as NonNullable<
        Parameters<
          typeof prepareEmbeddedAttemptSessionBoundary
        >[0]["attempt"]["userTurnTranscriptRecorder"]
      >;
      const boundary = await prepareEmbeddedAttemptSessionBoundary({
        activeSession,
        attempt: {
          sessionId: "session-boundary",
          onUserMessagePersistenceInvalidated,
          prompt: "current prompt",
          userTurnTranscriptRecorder: recorder,
        },
        getUserTranscriptContexts: () => undefined,
        isRawModelRun: false,
        preparedUserTurnMessage: prepared ? currentUser : undefined,
        sessionManager,
        setActiveSessionSystemPrompt: vi.fn(),
      });
      expect(boundary.orphanRepair).toBeUndefined();
      expect(activeSession.agent.state.messages).toEqual([]);
      expect(branchAsync).not.toHaveBeenCalled();
      expect(resetLeafAsync).not.toHaveBeenCalled();
      expect(setNextUserMessagePersistence).not.toHaveBeenCalled();
      expect(onUserMessagePersistenceInvalidated).not.toHaveBeenCalled();
    },
  );

  it.each([false])(
    "handles a different durable user leaf with current-turn exclusion %s",
    async (excludeFromContext) => {
      const currentUser = {
        role: "user" as const,
        content: "current prompt",
        idempotencyKey: "current-run:user",
        excludeFromContext,
        timestamp: 2,
      };
      const repairedMessages: AgentMessage[] = [currentUser];
      const { activeSession } = createActiveSession([]);
      const branchAsync = vi.fn(async () => undefined);
      const setNextUserMessagePersistence = vi.fn();
      const onUserMessagePersistenceInvalidated = vi.fn();
      const sessionManager = createSessionManager({
        getLeafEntry: () => ({
          id: "orphan-user",
          parentId: "previous-assistant",
          timestamp: "2026-07-13T00:00:00.000Z",
          type: "message",
          message: {
            role: "user",
            content: "old prompt",
            idempotencyKey: "previous-run:user",
            timestamp: 1,
          },
        }),
        branchAsync,
        setNextUserMessagePersistence,
        buildSessionContext: () => ({ messages: repairedMessages }),
      });
      const recorder = {
        getPersistedMessage: () => currentUser,
        hasPersisted: () => true,
      } as unknown as NonNullable<
        Parameters<
          typeof prepareEmbeddedAttemptSessionBoundary
        >[0]["attempt"]["userTurnTranscriptRecorder"]
      >;

      const boundary = await prepareEmbeddedAttemptSessionBoundary({
        activeSession,
        attempt: {
          sessionId: "session-boundary",
          onUserMessagePersistenceInvalidated,
          prompt: "current prompt",
          userTurnTranscriptRecorder: recorder,
        },
        getUserTranscriptContexts: () => undefined,
        isRawModelRun: false,
        preparedUserTurnMessage: undefined,
        sessionManager,
        setActiveSessionSystemPrompt: vi.fn(),
      });

      if (excludeFromContext) {
        expect(boundary.orphanRepair).toBeUndefined();
        expect(branchAsync).not.toHaveBeenCalled();
        expect(setNextUserMessagePersistence).not.toHaveBeenCalled();
        expect(onUserMessagePersistenceInvalidated).not.toHaveBeenCalled();
        expect(activeSession.agent.state.messages).toEqual([]);
      } else {
        expect(boundary.orphanRepair?.removeLeaf).toBe(true);
        expect(branchAsync).toHaveBeenCalledWith("previous-assistant");
        expect(setNextUserMessagePersistence).toHaveBeenCalledExactlyOnceWith("normal");
        expect(onUserMessagePersistenceInvalidated).toHaveBeenCalledOnce();
        expect(activeSession.agent.state.messages).toEqual(repairedMessages);
      }
    },
  );

  it("keeps failed-dispatch user input through repeated internal continuations", async () => {
    await withPersistedOrphanBoundary(
      { parent: true, metadata: true, idempotencyKey: "accepted-user:user" },
      async ({ input, manager, orphanId, target }) => {
        const original = manager.getEntry(orphanId);
        for (const sourceTool of ["subagent_announce", "subagent_settle"]) {
          const provenance = { kind: "inter_session" as const, sourceTool };
          input.attempt.inputProvenance = provenance;
          input.attempt.prompt = "The worker has finished.";
          input.activeSession.agent.state.messages = manager.buildSessionContext().messages;

          await prepareEmbeddedAttemptSessionBoundary(input);

          expect(input.activeSession.agent.state.messages).toContainEqual(
            expect.objectContaining({
              role: "user",
              content: "orphan wake",
              idempotencyKey: "accepted-user:user",
            }),
          );
          const reopened = SessionManager.openBounded(target, { maxBytes: 4096, maxEvents: 20 });
          expect(reopened.getBranch().filter((entry) => entry.id === orphanId)).toEqual([original]);
          // A failed continuation may persist its own input before producing an assistant.
          const announcement: PersistedUserTurnMessage = {
            role: "user",
            content: input.attempt.prompt,
            provenance,
            timestamp: 2,
          };
          manager.appendMessage(announcement);
        }
        expect(manager.buildSessionContext().messages).toMatchObject([
          { role: "user", content: "orphan wake", idempotencyKey: "accepted-user:user" },
          {
            role: "user",
            content: "The worker has finished.",
            provenance: { kind: "inter_session", sourceTool: "subagent_settle" },
          },
        ]);
      },
    );
  });

  it.each([
    {
      name: "an internal retry after the admitted user was persisted",
      suppressNextUserMessagePersistence: true,
      internalContinuation: true,
    },
  ])("keeps one canonical user turn for $name", async (testCase) => {
    const { suppressNextUserMessagePersistence, internalContinuation } = testCase;
    const recoveryPrompt = "gateway restart recovery";
    await withPersistedOrphanBoundary(
      {
        parent: true,
        metadata: true,
        restartRecovery: suppressNextUserMessagePersistence && !internalContinuation,
        suppressNextUserMessagePersistence,
        idempotencyKey: internalContinuation ? "orphan-projection:user" : undefined,
      },
      async ({ input, manager, orphanId, target }) => {
        input.attempt.prompt = recoveryPrompt;
        if (internalContinuation) {
          const persistedUser = manager
            .buildSessionContext()
            .messages.find((message) => message.role === "user");
          expect(persistedUser).toBeDefined();
          Object.assign(input.attempt, { skipPreparedUserTurnMessage: true });
          input.attempt.userTurnTranscriptRecorder = {
            hasPersisted: () => true,
            getPersistedMessage: () => persistedUser,
          } as NonNullable<typeof input.attempt.userTurnTranscriptRecorder>;
        }
        const boundary = await prepareEmbeddedAttemptSessionBoundary(input);

        expect(boundary.orphanRepair?.removeLeaf).toBe(!suppressNextUserMessagePersistence);
        expect(boundary.orphanRepair?.contextEnginePrompt).toContain("orphan wake");
        expect(boundary.orphanRepair?.contextEnginePrompt).toContain(recoveryPrompt);
        const mergedPrompt = boundary.orphanRepair!.contextEnginePrompt;
        const appendedUser = manager.appendMessage({
          role: "user",
          content: mergedPrompt,
          timestamp: 3,
        });
        expect(typeof appendedUser).toBe(
          suppressNextUserMessagePersistence ? "undefined" : "string",
        );
        manager.appendMessage(
          makeAssistantMessageFixture({
            content: [{ type: "text", text: "recovery reply" }],
            stopReason: "stop",
            timestamp: 4,
          }),
        );

        const reopened = SessionManager.openBounded(target, { maxBytes: 4096, maxEvents: 20 });
        expect(reopened.getBranch().some((entry) => entry.id === orphanId)).toBe(
          suppressNextUserMessagePersistence,
        );
        expect(reopened.buildSessionContext().messages).toMatchObject([
          {
            role: "user",
            content: suppressNextUserMessagePersistence ? "orphan wake" : mergedPrompt,
          },
          { role: "assistant", content: [{ type: "text", text: "recovery reply" }] },
        ]);
      },
    );
  });
});
