import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildOpenAIResponsesReasoningReplayMetadata } from "../../../../packages/ai/src/transports/openai-responses-compaction-replay.js";
import { buildOpenAIResponsesParams } from "../../../../packages/ai/src/transports/openai-responses-params-internal.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  appendTranscriptEvent,
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
import { createEnteredGate } from "../../entered-gate.test-support.js";
import type { AgentMessage } from "../../runtime/index.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { convertToLlm } from "../../sessions/messages.js";
import { sessionManagerReadInitialContext } from "../../sessions/session-manager-current-turn.js";
import {
  appendSessionTranscriptNote,
  withSessionManagerWrite,
} from "../../sessions/session-manager-write-admission.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { normalizeMessagesForLlmBoundary } from "./attempt-llm-boundary.js";
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
    orphanProvenance?: Record<string, unknown>;
    detachLeaf?: boolean;
    restartRecovery?: boolean;
    suppressNextUserMessagePersistence?: boolean;
    idempotencyKey?: string;
    excludeFromContext?: boolean;
    selectedOwner?: boolean;
    recoveryNotice?: "tail" | "before-metadata";
    history?: Parameters<SessionManager["appendMessageAsync"]>[0][];
    metadataBytes?: number;
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
    setRuntimeConfigSnapshot({});
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const seed = SessionManager.open(target, state.workspaceDir);
    if (options.parent) {
      await seed.appendModelChange("openai", "gpt-5.5");
    }
    for (const message of options.history ?? []) {
      await seed.appendMessageAsync(message);
    }
    const orphanId = seed.appendMessage({
      role: "user",
      content: "orphan wake",
      timestamp: 1,
      ...(options.orphanProvenance ? { provenance: options.orphanProvenance } : {}),
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      ...(options.excludeFromContext ? { excludeFromContext: true } : {}),
      ...(options.detachLeaf
        ? { provenance: { kind: "inter_session", sourceTool: "subagent_announce" } }
        : {}),
    });
    const appendRecoveryNotice = () =>
      appendTranscriptEvent(target, {
        type: "custom_message",
        id: "recovery-notice",
        parentId: seed.getAppendParentId(),
        timestamp: new Date(2).toISOString(),
        customType: "session-send-recovery-blocked",
        content: "Saved input could not be delivered because its endpoint was replaced.",
        display: true,
        excludeFromContext: true,
      });
    if (options.recoveryNotice === "before-metadata") {
      await appendRecoveryNotice();
      await seed.reloadPersistedTranscriptAsync();
    }
    if (options.metadata) {
      await seed.appendThinkingLevelChange("low");
      await seed.appendModelChange("openai", "gpt-5.5");
    }
    if (options.metadataBytes) {
      await seed.appendCustomEntryAsync("openclaw.cache-ttl", {
        fixture: "x".repeat(options.metadataBytes),
      });
    }
    if (options.recoveryNotice === "tail") {
      await appendRecoveryNotice();
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
    const { activeSession } = createActiveSession(
      (await manager[sessionManagerReadInitialContext]()).messages,
    );
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
  it.each(["main_session_restart_recovery", "cron_execution"])(
    "keeps the Responses model prefix through bounded %s orphan recovery",
    async (sourceTool) => {
      const model = makeProviderModelFixture<"openai-responses">({
        api: "openai-responses",
        provider: "openai",
        id: "test-model",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
      });
      const reasoningReplay = {
        openclawReasoningReplay: buildOpenAIResponsesReasoningReplayMetadata(model, {
          sessionId: "orphan-projection",
        }),
      };
      const history = Array.from({ length: 6 }, (_, index) => [
        {
          role: "user" as const,
          content: `question ${index} ` + "q".repeat(400),
          timestamp: index,
        },
        makeAssistantMessageFixture({
          stopReason: "stop",
          errorMessage: undefined,
          content: [
            {
              type: "thinking",
              thinking: "",
              thinkingSignature: JSON.stringify({
                type: "reasoning",
                id: `rs_fixture_${index}`,
                summary: [],
                encrypted_content: "Q".repeat(64),
              }),
              ...reasoningReplay,
            },
            { type: "text", text: `answer ${index} ` + "a".repeat(400) },
          ],
        }),
      ]).flat();
      await withPersistedOrphanBoundary(
        {
          parent: true,
          metadata: true,
          history,
          metadataBytes: 1400,
          orphanProvenance: { kind: "internal_system", sourceTool: "cron_execution" },
        },
        async ({ input, manager }) => {
          input.attempt.inputProvenance = { kind: "internal_system", sourceTool };
          input.attempt.config = { agents: { defaults: { userTimezone: "UTC" } } };
          const request = () =>
            buildOpenAIResponsesParams(
              model,
              {
                messages: convertToLlm(
                  normalizeMessagesForLlmBoundary(input.activeSession.agent.state.messages, {
                    sessionVersion: manager.getHeader()?.version,
                    timezone: "UTC",
                  }),
                ),
              },
              { sessionId: input.attempt.sessionId },
            );
          const before = request();
          expect(before.input!.length).toBeGreaterThan(2);
          expect(before.input?.some((item) => item.type === "reasoning")).toBe(true);
          expect((await prepareEmbeddedAttemptSessionBoundary(input)).orphanRepair).toBeDefined();
          const after = request();
          // Orphan assembly owns the final user input; all earlier provider bytes stay intact.
          expect(JSON.stringify(after.input)).toBe(JSON.stringify(before.input!.slice(0, -1)));
          expect(manager.getBranch().some((entry) => entry.type === "custom")).toBe(true);
        },
      );
    },
  );

  it.each(["tail", "before-metadata", "before-later-orphan"] as const)(
    "keeps an excluded recovery notice visible through later turns: %s",
    async (recoveryNotice) => {
      await withPersistedOrphanBoundary(
        {
          parent: true,
          metadata: true,
          recoveryNotice: recoveryNotice === "before-later-orphan" ? "tail" : recoveryNotice,
        },
        async ({ input, manager, orphanId, target }) => {
          const previousInputs = ["orphan wake"];
          if (recoveryNotice === "before-later-orphan") {
            previousInputs.push("later orphan wake");
            await manager.appendMessageAsync({
              role: "user",
              content: "later orphan wake",
              timestamp: 3,
            });
            input.activeSession.agent.state.messages = manager.buildSessionContext().messages;
          }
          const boundary = await prepareEmbeddedAttemptSessionBoundary(input);
          expect(boundary.orphanRepair).toBeUndefined();
          expect(input.activeSession.agent.state.messages).toMatchObject(
            previousInputs.map((content) => ({ role: "user", content })),
          );
          await manager.appendMessageAsync({ role: "user", content: "new request", timestamp: 3 });
          await manager.appendMessageAsync(
            makeAssistantMessageFixture({
              content: [{ type: "text", text: "new reply" }],
              timestamp: 4,
            }),
          );
          const reopened = await SessionManager.openAsync(target);
          expect(reopened.getBranch().map((entry) => entry.id)).toEqual(
            expect.arrayContaining([orphanId, "recovery-notice"]),
          );
          expect(reopened.buildSessionContext().messages).toMatchObject([
            ...previousInputs.map((content) => ({ role: "user", content })),
            { role: "user", content: "new request" },
            { role: "assistant", content: [{ type: "text", text: "new reply" }] },
          ]);
        },
      );
    },
  );

  it.each([
    { parent: false, metadata: false, prompt: "orphan wake" },
    { parent: true, metadata: true, prompt: "new consult" },
  ])("retains finalized Talk user speech through consult startup: $parent", async (options) => {
    await withPersistedOrphanBoundary(
      { ...options, orphanProvenance: { kind: "realtime_voice", sourceChannel: "talk" } },
      async ({ input, manager, orphanId, target }) => {
        input.attempt.prompt = options.prompt;
        const boundary = await prepareEmbeddedAttemptSessionBoundary(input);
        expect(boundary.orphanRepair?.removeLeaf).toBe(false);
        expect(boundary.orphanRepair?.contextEnginePrompt.match(/orphan wake/g)).toHaveLength(1);
        expect(input.activeSession.agent.state.messages).toEqual([]);
        const consult: PersistedUserTurnMessage = {
          role: "user",
          content: boundary.orphanRepair?.contextEnginePrompt ?? options.prompt,
          excludeFromContext: true,
          display: false,
          timestamp: 3,
        };
        await manager.appendMessageAsync(consult);
        await manager.appendMessageAsync(
          makeAssistantMessageFixture({
            content: [{ type: "text", text: "consult reply" }],
            timestamp: 4,
          }),
        );
        const reopened = await SessionManager.openAsync(target);
        expect(reopened.getBranch().map((entry) => entry.id)).toContain(orphanId);
        expect(reopened.buildSessionContext().messages).toMatchObject([
          { role: "user", content: "orphan wake" },
          { role: "assistant", content: [{ type: "text", text: "consult reply" }] },
        ]);
        expect(loadTranscriptEventsSync(target)).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "leaf" })]),
        );
      },
    );
  });

  it.each([
    { kind: "realtime_voice", sourceChannel: "discord" },
    { kind: "realtime_voice" },
    { kind: "internal_system", sourceChannel: "talk" },
  ] as const)("keeps ordinary orphan repair for $kind / $sourceChannel", async (provenance) => {
    await withPersistedOrphanBoundary(
      { parent: false, metadata: false, orphanProvenance: provenance },
      async ({ input, manager, orphanId }) => {
        const boundary = await prepareEmbeddedAttemptSessionBoundary(input);
        expect(boundary.orphanRepair?.removeLeaf).toBe(true);
        expect(manager.getBranch().map((entry) => entry.id)).not.toContain(orphanId);
      },
    );
  });

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
          const admittedGate = createEnteredGate();
          const speech = {
            ...makeAssistantMessageFixture({
              content: [{ type: "text", text: "voice reply" }],
              stopReason: "stop",
              timestamp: 2,
            }),
            provenance: { kind: "realtime_voice" as const, sourceChannel: "talk" },
          };
          const writing = withSessionManagerWrite(manager, async () => {
            await admittedGate.wait();
            await appendSessionTranscriptNote(target, speech);
          });
          await admittedGate.entered;
          const preparing = prepareEmbeddedAttemptSessionBoundary(input);
          admittedGate.release();
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
          await awaitGateBeforeSettlement(
            claimed.promise,
            outcome,
            "repair settled before its projection was claimed",
          );
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

  it.each([false, true])(
    "repairs only a different durable user leaf: %s",
    async (differentLeaf) => {
      const currentUser = {
        role: "user" as const,
        content: "current prompt",
        idempotencyKey: "current-run:user",
        timestamp: differentLeaf ? 2 : 1,
      };
      const repairedMessages: AgentMessage[] = [currentUser];
      const { activeSession } = createActiveSession([]);
      const branchAsync = vi.fn(async () => undefined);
      const resetLeafAsync = vi.fn(async () => undefined);
      const setNextUserMessagePersistence = vi.fn();
      const onUserMessagePersistenceInvalidated = vi.fn();
      const sessionManager = createSessionManager({
        branchAsync,
        resetLeafAsync,
        setNextUserMessagePersistence,
        [sessionManagerReadInitialContext]: async () => ({ messages: repairedMessages }),
        getEntry: () => undefined,
        getLeafEntry: () => ({
          id: differentLeaf ? "orphan-user" : "current-user",
          parentId: "previous-assistant",
          timestamp: "2026-07-13T00:00:00.000Z",
          type: "message",
          message: differentLeaf
            ? {
                role: "user",
                content: "old prompt",
                idempotencyKey: "previous-run:user",
                timestamp: 1,
              }
            : currentUser,
        }),
      });
      const recorder = {
        hasPersisted: () => differentLeaf,
        ...(differentLeaf ? { getPersistedMessage: () => currentUser } : {}),
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
        preparedUserTurnMessage: differentLeaf ? undefined : currentUser,
        sessionManager,
        setActiveSessionSystemPrompt: vi.fn(),
      });
      expect(resetLeafAsync).not.toHaveBeenCalled();
      if (!differentLeaf) {
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

  it("keeps input steered into a failed attempt when the retry replays its persisted user", async () => {
    const currentUser: PersistedUserTurnMessage = {
      role: "user",
      content: "current prompt",
      idempotencyKey: "current-run:user",
      timestamp: 1,
    };
    await withPersistedOrphanBoundary(
      {
        parent: true,
        metadata: false,
        idempotencyKey: "steered-run:user",
        history: [
          currentUser,
          makeAssistantMessageFixture({ content: [], stopReason: "error", timestamp: 1 }),
        ],
      },
      async ({ input, manager, orphanId, target }) => {
        input.attempt.prompt = "current prompt";
        input.attempt.userTurnTranscriptRecorder = {
          hasPersisted: () => true,
          getPersistedMessage: () => currentUser,
        } as NonNullable<typeof input.attempt.userTurnTranscriptRecorder>;

        await prepareEmbeddedAttemptSessionBoundary(input);

        const reply = await manager.appendMessageAsync(
          makeAssistantMessageFixture({
            content: [{ type: "text", text: "retry reply" }],
            stopReason: "stop",
            timestamp: 3,
          }),
        );
        expect(manager.getEntry(reply!)?.parentId).toBe(orphanId);
        const reopened = SessionManager.openBounded(target, { maxBytes: 4096, maxEvents: 20 });
        expect(reopened.buildSessionContext().messages).toMatchObject([
          { role: "user", content: "current prompt" },
          { role: "assistant", stopReason: "error" },
          { role: "user", content: "orphan wake", idempotencyKey: "steered-run:user" },
          { role: "assistant", content: [{ type: "text", text: "retry reply" }] },
        ]);
        // The replay resends the persisted user from context, so the later input must stay there.
        expect(input.activeSession.agent.state.messages.at(-1)).toMatchObject({
          role: "user",
          content: "orphan wake",
        });
      },
    );
  });

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

  it.each(["restart", "internal retry"])(
    "keeps one canonical user turn through %s",
    async (mode) => {
      const retry = mode === "internal retry";
      await withPersistedOrphanBoundary(
        {
          parent: retry,
          metadata: true,
          restartRecovery: !retry,
          suppressNextUserMessagePersistence: true,
          idempotencyKey: retry ? "orphan-projection:user" : undefined,
        },
        async ({ input, manager, orphanId, target }) => {
          if (retry) {
            input.attempt.prompt = "gateway restart recovery";
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
          expect(boundary.orphanRepair?.removeLeaf).toBe(false);
          expect(manager.getBranch().map((entry) => entry.id)).toContain(orphanId);
          const beforeAppend = SessionManager.openBounded(target, {
            maxBytes: 4096,
            maxEvents: 20,
          });
          expect(beforeAppend.getBranch().map((entry) => entry.id)).toContain(orphanId);
          expect(loadTranscriptEventsSync(target)).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: orphanId })]),
          );
          // Prompt assembly owns this input, but later turns still need the durable user.
          expect(input.activeSession.agent.state.messages).toEqual([]);
          if (retry) {
            expect(boundary.orphanRepair?.contextEnginePrompt).toContain("orphan wake");
            expect(boundary.orphanRepair?.contextEnginePrompt).toContain(input.attempt.prompt);
            expect(
              manager.appendMessage({
                role: "user",
                content: boundary.orphanRepair!.contextEnginePrompt,
                timestamp: 3,
              }),
            ).toBeUndefined();
          }
          const leafBeforeAppend = manager.getLeafId();
          const appended = manager.appendMessageWithTranscriptAnchor(
            makeAssistantMessageFixture({
              content: [{ type: "text", text: "recovery reply" }],
              stopReason: "stop",
              timestamp: retry ? 4 : 2,
            }),
          );
          expect(manager.getEntry(appended.entryId)?.parentId).toBe(leafBeforeAppend);
          expect(manager.getBranch().map((entry) => entry.id)).toEqual(
            expect.arrayContaining([orphanId, appended.entryId]),
          );
          const reopened = SessionManager.openBounded(target, { maxBytes: 4096, maxEvents: 20 });
          expect(reopened.getBranch().some((entry) => entry.id === orphanId)).toBe(true);
          expect(reopened.buildSessionContext().messages).toMatchObject([
            { role: "user", content: "orphan wake" },
            { role: "assistant", content: [{ type: "text", text: "recovery reply" }] },
          ]);
        },
      );
    },
  );
});
