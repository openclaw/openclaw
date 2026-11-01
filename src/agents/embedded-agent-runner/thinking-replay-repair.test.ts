import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { expect, it } from "vitest";
import { timestampedTextAssistant } from "../test-helpers/sparse-transcript.test-support.js";
import { asAppendMessage } from "./transcript-rewrite.test-support.js";

function rejectedThinkingAssistant(text?: string): Parameters<SessionManager["appendMessage"]>[0] {
  return asAppendMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private", thinkingSignature: "sig_bad" },
      ...(text === undefined ? [] : [{ type: "text", text }]),
    ],
    timestamp: 2,
  });
}

function createSession(...messages: Parameters<SessionManager["appendMessage"]>[0][]) {
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendMessage(asAppendMessage({ role: "user", content: "first", timestamp: 1 }));
  for (const message of messages) {
    sessionManager.appendMessage(message);
  }
  return sessionManager;
}

function branchMessages(manager: SessionManager) {
  return manager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
}

it("preserves downstream branch suffix entries after rewriting the first repaired assistant", async () => {
  const sessionManager = createSession(
    rejectedThinkingAssistant("first answer"),
    asAppendMessage({ role: "user", content: "follow-up", timestamp: 3 }),
    asAppendMessage(timestampedTextAssistant("follow-up answer", 4)),
    rejectedThinkingAssistant(),
  );

  const { repairRejectedThinkingReplayInSessionManager: repairThinking } =
    await import("./thinking-replay-repair.js");
  expect(await repairThinking({ sessionManager })).toMatchObject({ repaired: true });
  expect(
    branchMessages(sessionManager).map((message) =>
      message.role === "assistant" || message.role === "user"
        ? { role: message.role, content: message.content }
        : message,
    ),
  ).toEqual([
    { role: "user", content: "first" },
    { role: "assistant", content: [{ type: "text", text: "first answer" }] },
    { role: "user", content: "follow-up" },
    { role: "assistant", content: [{ type: "text", text: "follow-up answer" }] },
    { role: "assistant", content: [{ type: "text", text: "[assistant reasoning omitted]" }] },
  ]);
  const beforeLeafId = sessionManager.getLeafId();
  expect(await repairThinking({ sessionManager })).toMatchObject({ repaired: false });
  expect(sessionManager.getLeafId()).toBe(beforeLeafId);
});
it("rewrites from the checkpoint identity that supplied the rejected request", async () => {
  const { repairRejectedCompactionReplayInSessionManager: repairCompaction } =
    await import("./thinking-replay-repair.js");
  const sessionManager = createSession();
  const checkpoint = { data: "rejected-ciphertext", id: "cmp_rejected" };
  for (const [data, id, timestamp] of [
    ["rejected-ciphertext", "cmp_rejected", 2],
    ["newer-ciphertext", "cmp_newer", 4],
  ] as const) {
    sessionManager.appendMessage(
      asAppendMessage({
        ...timestampedTextAssistant(id, timestamp),
        providerReplay: {
          v: 1,
          type:
            id === "cmp_rejected"
              ? "openai-responses-retained-compaction"
              : "openai-responses-compaction",
          data,
          id,
          replayIndex: 0,
        },
      }),
    );
    sessionManager.appendMessage(
      asAppendMessage({ role: "user", content: `after ${id}`, timestamp: timestamp + 1 }),
    );
  }

  expect(await repairCompaction({ sessionManager, checkpoint })).toMatchObject({ repaired: true });
  expect(
    branchMessages(sessionManager)
      .filter((message) => message.role === "assistant")
      .map((message) => message.providerReplay),
  ).toEqual([undefined, undefined]);
});
