import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as reconciliation from "../../config/sessions/session-transcript-reconcile.js";
import { useReconcileWorkerObserver } from "../../config/sessions/session-transcript-reconcile.test-support.js";
import type { SessionTranscriptReconcileWorkerMessage } from "../../config/sessions/session-transcript-reconcile.worker.js";
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
      const held = createDeferred();
      let releaseAcknowledgement: (() => void) | undefined;
      let released = false;
      observer.onTask = ({ input, port, observeMessage }) => {
        if (input.mode !== "disk" || input.path !== admission.storePath) {
          return;
        }
        const postMessage = port.postMessage.bind(port);
        let startingTarget = false;
        observeMessage((message: SessionTranscriptReconcileWorkerMessage) => {
          startingTarget =
            message.type === "plan-start" && message.plan.sessionId === target.sessionId;
        });
        port.postMessage = (message: unknown, transferList) => {
          const options = Array.isArray(transferList) ? { transfer: transferList } : transferList;
          if (startingTarget && !released) {
            startingTarget = false;
            releaseAcknowledgement = () => postMessage(message, options);
            held.resolve();
            return;
          }
          postMessage(message, options);
        };
      };
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
        await Promise.race([
          held.promise,
          joined.then(() => {
            throw new Error("expected a deferred projection rebuild");
          }),
        ]);
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
        const phase = await Promise.race([
          waiting.promise.then(() => "waiting"),
          outcome.then(() => "finished"),
        ]);
        expect(record).not.toHaveBeenCalled();
        expect(phase, "finalization must not finish without its recovered terminal anchor").toBe(
          "waiting",
        );
        if (cancel) {
          controller.abort(new Error("cancelled recovery"));
          await expect(outcome).rejects.toMatchObject({ name: "AbortError" });
          expect(record).not.toHaveBeenCalled();
        } else {
          released = true;
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
        released = true;
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
