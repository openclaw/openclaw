import { describe, expect, it, vi } from "vitest";
import {
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { handleEmbeddedAttemptPromptError } from "./attempt-prompt-submit.js";
import { SESSIONS_YIELD_ABORT_REASON } from "./attempt-sessions-yield.js";

registerAgentSessionLoopTestLifecycle();

describe("sessions_yield transcript handoff", () => {
  it.each([
    { yieldMessage: null, retainedBytes: 0, bounded: false },
    { yieldMessage: "Continue after the child completes", retainedBytes: 0, bounded: false },
    {
      yieldMessage: "Continue after the child completes",
      retainedBytes: 3 * 1024 * 1024,
      bounded: true,
    },
    {
      yieldMessage: "Continue after the child completes",
      retainedBytes: 3 * 1024 * 1024,
      bounded: false,
    },
  ])(
    "leaves yielded history ready (context=$yieldMessage, retainedBytes=$retainedBytes, bounded=$bounded)",
    async ({ yieldMessage, retainedBytes, bounded }) => {
      await withOpenClawTestState({ label: "yield-projection-handoff" }, async (state) => {
        const target = {
          agentId: "main",
          sessionId: "yielded-session",
          sessionKey: "agent:main:yielded-session",
          storePath: state.statePath("sessions.json"),
        };
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
        const seed = SessionManager.open(target, state.workspaceDir);
        // Large histories rebuild asynchronously after yield cleanup replaces them.
        for (let index = 0; index < 4_001; index += 1) {
          seed.appendCustomEntry("fixture-history", { index });
        }
        const manager = bounded
          ? SessionManager.openBounded(target, {
              cwd: state.workspaceDir,
              maxBytes: 4096,
              maxEvents: 20,
            })
          : seed;
        const { session } = await createTestSession({ sessionManager: manager });
        const user: AgentMessage = { role: "user", content: "Continue the task", timestamp: 1 };
        const toolResult: AgentMessage = {
          role: "toolResult",
          toolCallId: "yield-call",
          toolName: "sessions_yield",
          content: [{ type: "text", text: "yielded" }],
          isError: false,
          timestamp: 2,
        };
        const aborted = createAssistant(testModel, [], "aborted");
        manager.appendMessage(user);
        manager.appendMessage(toolResult);
        manager.appendMessage(aborted);
        const metadata = { text: "x".repeat(retainedBytes) };
        const metadataId =
          retainedBytes > 0
            ? manager.appendCustomEntry("retained-plugin-state", metadata)
            : undefined;
        // A live yield still has the synthetic abort that normal history loading omits.
        session.agent.state.messages = [user, toolResult, aborted];
        try {
          await handleEmbeddedAttemptPromptError({
            activeSession: session,
            attempt: { runId: "yielding-run", sessionId: target.sessionId },
            error: new Error("aborted", { cause: SESSIONS_YIELD_ABORT_REASON }),
            handleMidTurnPrecheckRequest: vi.fn(),
            markYieldAborted: vi.fn(),
            releaseLeasedSteering: vi.fn(),
            withOwnedTranscriptWrite: async (operation) => await operation(),
            yieldAbortSettled: null,
            yieldDetected: true,
            yieldMessage,
          });
          // Reopen exactly as the next queued attempt does, with no unrelated await.
          const reopened = SessionManager.open(target, state.workspaceDir, {
            maxBytes: retainedBytes > 0 ? 8 * 1024 * 1024 : 4096,
            maxEvents: 20,
          });
          const messages = reopened.buildSessionContext().messages;
          expect(messages.map((message) => message.role)).toEqual(
            yieldMessage ? ["user", "toolResult", "custom"] : ["user", "toolResult"],
          );
          expect(messages[0]).toMatchObject({ content: "Continue the task" });
          if (metadataId) {
            const retained = loadTranscriptEventsSync(target).find(
              (entry) =>
                typeof entry === "object" &&
                entry !== null &&
                "id" in entry &&
                entry.id === metadataId,
            );
            expect(JSON.stringify(retained).includes(metadata.text)).toBe(true);
          }
        } finally {
          session.dispose();
        }
      });
    },
  );
});
