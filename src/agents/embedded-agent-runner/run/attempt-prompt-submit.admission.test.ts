import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
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
          sessionPromptState: getEmbeddedSessionPromptState(sessionId),
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
});
