import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { ContextEngineLogicalTurnLease } from "../../harness/context-engine-logical-turn.js";
import { drainPendingContextEngineTurnsBeforeRun } from "../../harness/context-engine-turn-attempt.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
} from "../session-prompt-state.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { preparePersistedCurrentUserTurn } from "./pre-persisted-user-turn.js";

registerAgentSessionLoopTestLifecycle();
const sessionId = "attempt-prompt-admission-test";
afterEach(() => clearEmbeddedSessionPromptStates([sessionId]));

describe("embedded provider dispatch admission", () => {
  it.each(["committed", "failed", "sync-failed"] as const)(
    "waits for fresh runtime admission before provider dispatch (%s)",
    async (outcome) => {
      await withOpenClawTestState({ label: "prompt-admission" }, async (state) => {
        const target = {
          agentId: "main",
          sessionId,
          sessionKey: "agent:main:prompt-admission",
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
        };
        await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
        const message = {
          role: "user" as const,
          content: "transcript prompt",
          idempotencyKey: "prompt-admission:user",
          timestamp: 1,
        };
        const recorder = createUserTurnTranscriptRecorder({
          message,
          target: { ...target, sessionEntry: { sessionId, updatedAt: 1 } },
        });
        const admission = createDeferred();
        recorder.setAdmissionHandler?.(() => {
          if (outcome === "sync-failed") {
            throw new Error("durable admission failed");
          }
          return admission.promise;
        });
        const dispatchBoundary = createDeferred();
        const waitForPersistence = recorder.waitForRuntimePersistence;
        vi.spyOn(recorder, "waitForRuntimePersistence").mockImplementation(() => {
          dispatchBoundary.resolve();
          return waitForPersistence();
        });
        streamMocks.streamSimple.mockImplementation((model) => {
          // The unfixed path reaches the provider instead of the persistence wait.
          dispatchBoundary.resolve();
          return createAssistantResultStream(
            createAssistant(model, [{ type: "text", text: "done" }]),
          );
        });
        const sessionManager = guardSessionManager(
          SessionManager.open(target, state.workspaceDir),
          { preparedUserTurnMessage: message, preparedUserTurnTranscriptRecorder: recorder },
        );
        const { session } = await createTestSession({ sessionManager });
        expect(recorder.getAdmissionReceipt()).toBeUndefined();
        const submitting = submitEmbeddedAttemptPrompt({
          contextTokenBudget: 8_000,
          images: [],
          modelPrompt: message.content,
          onFinalPromptText: vi.fn(),
          onSteeringAcknowledged: vi.fn(),
          persistToolResultProjections: async () => {},
          runtimeOnly: false,
          systemPrompt: "system prompt",
          toolResultAggregateMaxChars: 8_000,
          toolResultMaxChars: 4_000,
          toolResultPromptProjectionState: getEmbeddedSessionPromptState(sessionId).toolResults,
          trajectoryRecorder: null,
          transcriptLeafId: null,
          transcriptPrompt: message.content,
          attempt: { sessionId, userTurnTranscriptRecorder: recorder },
          activeSession: session,
          promptActiveSession: (prompt, options) => session.prompt(prompt, options),
        });
        try {
          // The actual user append starts admission; the test never calls the waiter.
          await Promise.race([dispatchBoundary.promise, submitting]);
          expect(recorder.getAdmissionReceipt()).toMatchObject({ sessionId });
          expect(streamMocks.streamSimple).not.toHaveBeenCalled();
        } finally {
          if (outcome === "failed") {
            admission.reject(new Error("durable admission failed"));
          } else {
            admission.resolve();
          }
          await submitting;
        }
        if (outcome !== "committed") {
          expect(streamMocks.streamSimple).not.toHaveBeenCalled();
          expect(session.messages.at(-1)).toMatchObject({
            role: "assistant",
            stopReason: "error",
            errorMessage: expect.stringContaining("durable admission failed"),
          });
        } else {
          expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
          expect(session.getLastAssistantText()).toBe("done");
        }
      });
    },
  );

  it.each(["matching", "replay", "agentId", "sessionId", "sessionKey", "storePath"] as const)(
    "composes the real manager writer, durable callback, recorder wait and provider gate (%s)",
    async (field) => {
      await withOpenClawTestState({ label: "composed-admission" }, async (state) => {
        const target = {
          agentId: "main",
          sessionId,
          sessionKey: "agent:main:composed-admission",
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
        };
        await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
        const message = {
          role: "user" as const,
          content: "synthetic composed input",
          idempotencyKey: "composed-admission:user",
          timestamp: 1,
        };
        const recorder = createUserTurnTranscriptRecorder({
          message,
          target: { ...target, sessionEntry: { sessionId, updatedAt: 1 } },
        });
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
          commitTurn: async () => ({ status: "committed" }),
        };
        const lease: ContextEngineLogicalTurnLease = {
          engine,
          effectiveEngine: engine,
          effectiveEngineId: "test",
          effectiveEnginePluginId: undefined,
          degraded: false,
          degradedReason: undefined,
          selectForHost: vi.fn(),
          degradeBeforeStart: vi.fn(),
          begin: vi.fn(),
          deferDisposalUntil: vi.fn(),
          dispose: vi.fn(async () => undefined),
        };
        const prepared =
          field === "matching" || field === "replay" || field === "agentId"
            ? { ...target }
            : {
                ...target,
                [field]:
                  field === "storePath"
                    ? path.join(state.workspaceDir, "alternate", "openclaw-agent.sqlite")
                    : `synthetic-other-${field}`,
              };
        await drainPendingContextEngineTurnsBeforeRun({
          admission: undefined,
          lease,
          recorder,
          sessionTarget: prepared,
        });
        expect(lease.degradeBeforeStart).not.toHaveBeenCalled();
        // Deliberate mutation probes the retained callback, not a reachable producer defect.
        // A conflicting agent/store pair is correctly rejected earlier during preparation.
        if (field === "agentId") {
          prepared.agentId = "other";
        }
        streamMocks.streamSimple.mockImplementation((model) =>
          createAssistantResultStream(createAssistant(model, [{ type: "text", text: "done" }])),
        );
        const manager = SessionManager.open(target, state.workspaceDir);
        if (field === "replay") {
          await manager.appendMessage(message);
          const markPersisted = vi.spyOn(recorder, "markRuntimePersisted");
          const replay = await preparePersistedCurrentUserTurn({
            sessionManager: manager,
            message,
            recorder,
            runId: "synthetic-replay-run",
          });
          expect(replay).toBeDefined();
          expect(markPersisted).toHaveBeenCalledWith(message, expect.any(Object), {
            appended: false,
          });
          await recorder.waitForRuntimePersistence();
        }
        const sessionManager = guardSessionManager(manager, {
          preparedUserTurnMessage: message,
          preparedUserTurnTranscriptRecorder: recorder,
          suppressNextUserMessagePersistence: field === "replay",
        });
        const { session } = await createTestSession({ sessionManager });
        if (field !== "replay") {
          expect(recorder.getAdmissionReceipt()).toBeUndefined();
        }
        await submitEmbeddedAttemptPrompt({
          contextTokenBudget: 8_000,
          images: [],
          modelPrompt: message.content,
          onFinalPromptText: vi.fn(),
          onSteeringAcknowledged: vi.fn(),
          persistToolResultProjections: async () => {},
          runtimeOnly: false,
          systemPrompt: "system prompt",
          toolResultAggregateMaxChars: 8_000,
          toolResultMaxChars: 4_000,
          toolResultPromptProjectionState: getEmbeddedSessionPromptState(sessionId).toolResults,
          trajectoryRecorder: null,
          transcriptLeafId: null,
          transcriptPrompt: message.content,
          attempt: { sessionId, userTurnTranscriptRecorder: recorder },
          activeSession: session,
          promptActiveSession: (prompt, options) => session.prompt(prompt, options),
        });
        expect(recorder.getAdmissionReceipt()).toMatchObject({
          agentId: target.agentId,
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
          storePath: target.storePath,
        });
        if (field === "matching" || field === "replay") {
          expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
          expect(session.getLastAssistantText()).toBe("done");
        } else {
          expect(streamMocks.streamSimple).not.toHaveBeenCalled();
          const expected = {
            agentIdMatches: field !== "agentId",
            sessionIdMatches: field !== "sessionId",
            sessionKeyMatches: field !== "sessionKey",
            storePathMatches: field !== "storePath",
          };
          const diagnostic =
            "context-engine transcript target changed before provider dispatch " +
            JSON.stringify(expected);
          await expect(recorder.waitForRuntimePersistence()).rejects.toHaveProperty(
            "message",
            diagnostic,
          );
          console.info("runtime-dispatch-admission", diagnostic, "providerCalls=0");
          expect(session.messages.at(-1)).toMatchObject({
            role: "assistant",
            stopReason: "error",
            errorMessage: expect.stringContaining(diagnostic),
          });
        }
      });
    },
  );
});
