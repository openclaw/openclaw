import { describe, expect, it } from "vitest";
import {
  createAssistant,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { withInterruptedTurn } from "./attempt-session-replay.test-support.js";

registerAgentSessionLoopTestLifecycle();

describe("prepared session tool-call persistence", () => {
  it("persists an answered call to an unknown tool as the live run sent it", async () => {
    await withInterruptedTurn(
      false,
      async (fixture) => {
        const { sessionManager } = await fixture.prepare();
        const call = createAssistant(
          testModel,
          [
            { type: "toolCall", id: "call_missing", name: "missing_tool", arguments: {} },
            { type: "toolCall", id: "call_read", name: "read", arguments: {} },
          ],
          "toolUse",
        );
        await sessionManager.appendMessageAsync(call);
        for (const [toolCallId, toolName, text] of [
          ["call_missing", "missing_tool", "Tool missing_tool not found"],
          ["call_read", "read", "fixture"],
        ] as const) {
          await sessionManager.appendMessageAsync({
            role: "toolResult",
            toolCallId,
            toolName,
            content: [{ type: "text", text }],
            isError: toolName === "missing_tool",
            timestamp: Date.now(),
          });
        }
        // The next run replays the transcript; it must hold the bytes the provider already saw.
        const stored = SessionManager.open(fixture.target)
          .buildSessionContext()
          .messages.find((message) => message.role === "assistant");
        expect(stored?.content).toEqual(call.content);
      },
      { interruptedTurn: false },
    );
  });
});
