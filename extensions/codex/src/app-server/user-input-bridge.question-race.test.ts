import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  getGlobalQuestionManager,
  resetGlobalQuestionManagerForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
// Tests the codex user-input bridge convergence + race: a Codex requestUserInput
// is ALSO registered with the global QuestionManager (so it renders on the card /
// channel buttons), and whichever resolves first wins — a structured
// question.resolve OR the legacy next-free-text reply — with the loser cancelled.
import { describe, expect, it, beforeEach } from "vitest";
import { createCodexUserInputBridge } from "./user-input-bridge.js";

const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";

function makeParamsForRun(): EmbeddedRunAttemptParams {
  return {
    sessionKey: "s1",
    onPartialReply: async () => {},
  } as unknown as EmbeddedRunAttemptParams;
}

function makeRequest(id: number) {
  return {
    id,
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: "item-1",
      questions: [
        {
          id: "q1",
          header: "Deploy",
          question: "Ship it?",
          isOther: true,
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    },
  };
}

describe("codex user-input bridge — question lane convergence + race", () => {
  beforeEach(() => {
    resetGlobalQuestionManagerForTest();
  });

  it("registers the question with the manager and resolves via structured question.resolve", async () => {
    const bridge = createCodexUserInputBridge({
      paramsForRun: makeParamsForRun(),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    const replyPromise = bridge.handleRequest(makeRequest(1));
    await Promise.resolve();

    const manager = getGlobalQuestionManager();
    const [record] = manager.list();
    expect(record).toBeDefined();
    expect(record.sessionKey).toBe("s1");

    // A surface (Control UI / channel) answers structurally.
    expect(manager.resolve(record.id, { q1: { text: "Yes" } }, "ui")).toBe(true);

    await expect(replyPromise).resolves.toEqual({ answers: { q1: { answers: ["Yes"] } } });
    expect(manager.getSnapshot(record.id)?.status).toBe("resolved");
  });

  it("resolves via the legacy free-text reply and cancels (expires) the rendered question", async () => {
    const bridge = createCodexUserInputBridge({
      paramsForRun: makeParamsForRun(),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    const replyPromise = bridge.handleRequest(makeRequest(2));
    await Promise.resolve();

    const manager = getGlobalQuestionManager();
    const [record] = manager.list();
    expect(record).toBeDefined();

    // The user replies with free text before any surface presses a button.
    expect(bridge.handleQueuedMessage("No")).toBe(true);

    await expect(replyPromise).resolves.toEqual({ answers: { q1: { answers: ["No"] } } });
    // The rendered question is dismissed everywhere.
    expect(manager.getSnapshot(record.id)?.status).toBe("expired");
  });

  it("cancels the rendered question when the turn is aborted", async () => {
    const controller = new AbortController();
    const bridge = createCodexUserInputBridge({
      paramsForRun: makeParamsForRun(),
      threadId: THREAD_ID,
      turnId: TURN_ID,
      signal: controller.signal,
    });
    const replyPromise = bridge.handleRequest(makeRequest(3));
    await Promise.resolve();
    const manager = getGlobalQuestionManager();
    const [record] = manager.list();
    expect(record).toBeDefined();

    controller.abort();
    await replyPromise;
    expect(manager.getSnapshot(record.id)?.status).toBe("expired");
  });
});
