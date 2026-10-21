import { expect, it } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { appendTranscriptMessages } from "../../config/sessions/session-accessor.transcript-turn.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { withSessionState } from "./session-manager-fixtures.test-support.js";
import { SessionManager } from "./session-manager.js";
import { toolResult } from "./session-message-fixtures.test-support.js";

function turn(index: number, resultBytes = 0) {
  const id = `turn-${index}`;
  const messages = [
    makeUserMessage(`${id}: ${"x".repeat(256)}`, index),
    makeAgentAssistantMessage({
      content: [{ type: "toolCall", id, name: "read", arguments: { path: "fixture.txt" } }],
      stopReason: "toolUse",
    }),
    toolResult(`receipt ${index}${"x".repeat(resultBytes)}`, id, index),
  ];
  return messages.map((message, offset) => ({
    eventId: `${id}-${["user", "call", "result"][offset]}`,
    message,
  }));
}

it("keeps complete history prefixes across appends and restarts the window after compaction and reset", async () => {
  await withSessionState("prefix", async ({ scope }) => {
    setRuntimeConfigSnapshot({});
    await appendTranscriptMessages(scope, {
      messages: Array.from({ length: 30 }, (_, index) => turn(index)).flat(),
    });
    const limits = { maxBytes: 16_384, maxEvents: 1000 };
    const read = () => SessionManager.openModelContext(scope, { limits }).buildSessionContext();
    let previous = read().messages;
    expect(previous.length).toBeLessThan(90);
    const streak = { length: 1, longest: 1, steps: 0 };
    for (let index = 30; index < 40; index++) {
      await appendTranscriptMessages(scope, { messages: turn(index) });
      // Each read creates a fresh detached manager: no process-local cutoff can supply stability.
      const current = read().messages;
      expect(Buffer.byteLength(JSON.stringify(current))).toBeLessThan(limits.maxBytes);
      expect(current[0]?.role).toBe("user");
      for (let offset = 0; offset < current.length; offset += 3) {
        const [user, call, result] = current.slice(offset, offset + 3);
        expect([user?.role, call?.role, result?.role]).toEqual(["user", "assistant", "toolResult"]);
        if (call?.role === "assistant" && result?.role === "toolResult") {
          expect(call.content).toContainEqual(expect.objectContaining({ id: result.toolCallId }));
        }
      }
      if (JSON.stringify(current[0]) === JSON.stringify(previous[0])) {
        expect(current.slice(0, previous.length)).toEqual(previous);
        streak.longest = Math.max(streak.longest, ++streak.length);
      } else {
        streak.steps++;
        streak.length = 1;
      }
      previous = current;
    }
    expect(streak.longest).toBeGreaterThanOrEqual(3);
    expect(streak.steps).toBeGreaterThan(0);

    const source = SessionManager.open(scope);
    source.appendCompaction("Earlier turns summarized", "turn-39-user", 100);
    expect(read().messages).toEqual(source.buildSessionContext().messages);
    source.appendResetBoundary("new");
    expect(read().messages).toEqual([]);
    source.appendMessage(makeUserMessage("fresh start", 40));
    expect(read().messages).toEqual([makeUserMessage("fresh start", 40)]);
    source.appendMessage(makeUserMessage("old".repeat(700), 41));
    await appendTranscriptMessages(scope, { messages: turn(42, 14_500) });
    // Headroom must not reject an atomic tool turn that fits the unchanged hard cap.
    expect(read().messages).toEqual(
      SessionManager.openModelContext(scope).buildSessionContext().messages.slice(-3),
    );
  });
});
