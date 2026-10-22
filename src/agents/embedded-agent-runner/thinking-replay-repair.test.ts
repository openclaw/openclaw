import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { describe, expect, it } from "vitest";
import { timestampedTextAssistant } from "../test-helpers/sparse-transcript.test-support.js";
import {
  repairRejectedCompactionReplayInSessionManager,
  repairRejectedThinkingReplayInSessionManager,
} from "./thinking-replay-repair.js";

function append(session: SessionManager, ...messages: unknown[]) {
  for (const message of messages) {
    session.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
  }
}

function sessionWith(...messages: unknown[]) {
  const session = SessionManager.inMemory();
  append(session, ...messages);
  return session;
}

const user = (content = "first", timestamp = 1) => ({ role: "user", content, timestamp });
const thinking = { type: "thinking", thinking: "private", thinkingSignature: "sig_bad" };
const text = (value: string) => ({ type: "text", text: value });
const assistant = (...content: unknown[]) => ({ role: "assistant", content, timestamp: 2 });

function branchMessages(sessionManager: SessionManager): AgentMessage[] {
  return sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
}

function branchAssistantContents(sessionManager: SessionManager): unknown[] {
  return branchMessages(sessionManager)
    .filter((message) => message.role === "assistant")
    .map((message) => message.content);
}

describe("repairRejectedThinkingReplayInSessionManager", () => {
  it("preserves downstream branch suffix entries after rewriting the first repaired assistant", async () => {
    const sessionManager = sessionWith(
      user(),
      assistant(thinking, text("first answer")),
      user("follow-up", 3),
      timestampedTextAssistant("follow-up answer", 4),
    );

    const result = await repairRejectedThinkingReplayInSessionManager({ sessionManager });

    expect(result).toMatchObject({ repaired: true });
    expect(branchMessages(sessionManager).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(branchAssistantContents(sessionManager)).toEqual([
      [text("first answer")],
      [text("follow-up answer")],
    ]);
  });
});

describe("repairRejectedCompactionReplayInSessionManager", () => {
  it("rewrites from the checkpoint identity that supplied the rejected request", async () => {
    const sessionManager = sessionWith(user());
    for (const [data, id, timestamp] of [
      ["rejected-ciphertext", "cmp_rejected", 2],
      ["newer-ciphertext", "cmp_newer", 4],
    ] as const) {
      append(
        sessionManager,
        {
          role: "assistant",
          content: [text(id)],
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
          timestamp,
        },
        user(`after ${id}`, timestamp + 1),
      );
    }

    expect(
      await repairRejectedCompactionReplayInSessionManager({
        sessionManager,
        checkpoint: { data: "rejected-ciphertext", id: "cmp_rejected" },
      }),
    ).toMatchObject({ repaired: true });
    expect(
      branchMessages(sessionManager)
        .filter((message) => message.role === "assistant")
        .map((message) => message.providerReplay),
    ).toEqual([undefined, undefined]);
  });
});
