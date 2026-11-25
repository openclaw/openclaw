import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as reconciliation from "../../config/sessions/session-transcript-reconcile.js";
import {
  holdReconcileAck,
  useReconcileWorkerObserver,
} from "../../config/sessions/session-transcript-reconcile.test-support.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { removeTrailingMidTurnPrecheckAssistantError } from "../embedded-agent-runner/run/attempt-transcript-helpers.js";
import { truncateOversizedToolResultsInSessionManager } from "../embedded-agent-runner/tool-result-truncation.js";
import {
  captureCompletedTurnMessageAnchor,
  completedTurnMessageAnchor,
} from "../sessions/session-manager-message-anchor.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { createContextEngine } from "./context-engine-lifecycle.test-support.js";
import { finalizeTurn } from "./context-engine-turn.test-support.js";

vi.mock("node:worker_threads", async () =>
  (
    await import("../../config/sessions/session-transcript-reconcile.test-support.js")
  ).createObservedWorkerThreads(),
);
const observer = useReconcileWorkerObserver();
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "finalizes rewritten history without publishing after cancellation (cancel=%s)",
  async (cancel) => {
    await withOpenClawTestState({ label: "turn-recovery-projection" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "recovery",
        sessionKey: "agent:main:recovery",
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
        sessionEntry: undefined,
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const recorder = createUserTurnTranscriptRecorder({
        target,
        input: { text: "Summarize the tool evidence" },
        updateMode: "none",
      });
      await recorder.persistApproved();
      const admission = recorder.getAdmissionReceipt();
      assert(admission, "expected a persisted user-turn admission");
      const sessionManager = await SessionManager.openAsync(target, state.workspaceDir);
      for (let index = 0; index < 2; index++) {
        const id = `read-${index}`;
        await sessionManager.appendMessageAsync(
          makeAgentAssistantMessage({
            content: [{ type: "toolCall", id, name: "read", arguments: {} }],
            stopReason: "toolUse",
          }),
        );
        await sessionManager.appendMessageAsync({
          role: "toolResult",
          toolCallId: id,
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "a".repeat(2_200_000) }],
          timestamp: 2,
        });
      }
      // Legacy sessions can retain the synthetic error that new guarded writes omit.
      await sessionManager.appendMessageAsync(
        makeAgentAssistantMessage({
          content: [],
          stopReason: "error",
          errorMessage: "Context overflow: prompt too large for the model (mid-turn precheck).",
        }),
      );
      const held = holdReconcileAck(observer, "plan-start", target.sessionId, admission.storePath);
      let releaseAcknowledgement: (() => void) | undefined = held.release;
      let outcome: ReturnType<typeof finalizeTurn> | undefined;
      try {
        const result = await truncateOversizedToolResultsInSessionManager({
          sessionManager,
          contextWindowTokens: 272_000,
          ...target,
        });
        expect(result.truncated).toBe(true);
        const activeSession = {
          agent: { state: { messages: sessionManager.buildSessionContext().messages } },
        };
        await removeTrailingMidTurnPrecheckAssistantError({ activeSession, sessionManager });
        const joined = reconciliation.waitForSessionTranscriptIndexReconcile({
          agentId: target.agentId,
          path: admission.storePath,
        });
        await awaitGateBeforeSettlement(held.paused, joined, "projection rebuilt early");
        const terminalEntryId = sessionManager.getLeafId();
        assert(terminalEntryId, "recovery must retain a terminal entry");
        const record = vi.fn();
        const controller = new AbortController();
        const waiting = createDeferred();
        const wait = reconciliation.waitForSessionTranscriptProjection;
        // Observe the real barrier without replacing its worker or readiness checks.
        vi.spyOn(reconciliation, "waitForSessionTranscriptProjection").mockImplementation(
          (...args) => {
            const pending = wait(...args);
            waiting.resolve();
            return pending;
          },
        );
        outcome = finalizeTurn({
          abortSignal: controller.signal,
          contextEngine: createContextEngine(),
          sessionIdUsed: target.sessionId,
          sessionKey: target.sessionKey,
          sessionFile: "",
          turnCandidate: {
            admission,
            terminalEntryId,
            [completedTurnMessageAnchor]: captureCompletedTurnMessageAnchor(
              sessionManager,
              terminalEntryId,
            ),
            record,
          },
        });
        await awaitGateBeforeSettlement(waiting.promise, outcome, "finalization bypassed recovery");
        expect(record).not.toHaveBeenCalled();
        if (cancel) {
          controller.abort(new Error("cancelled recovery"));
          await expect(outcome).rejects.toMatchObject({ name: "AbortError" });
          expect(record).not.toHaveBeenCalled();
        } else {
          releaseAcknowledgement?.();
          releaseAcknowledgement = undefined;
          await outcome;
          expect(record).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              boundary: {
                admission,
                terminal: expect.objectContaining({ entryId: terminalEntryId }),
              },
            }),
          );
        }
      } finally {
        releaseAcknowledgement?.();
        await outcome?.catch(() => {});
        await reconciliation.waitForSessionTranscriptIndexReconcile({
          agentId: target.agentId,
          path: admission.storePath,
        });
      }
      const reopened = await SessionManager.openAsync(target, state.workspaceDir);
      const messages = reopened.buildSessionContext().messages;
      expect(messages[0]).toMatchObject({ role: "user", content: "Summarize the tool evidence" });
      expect(
        messages.some((message) => message.role === "assistant" && message.stopReason === "error"),
      ).toBe(false);
    });
  },
);
