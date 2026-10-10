import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexConversationTurnCollector } from "./conversation-turn-collector.js";

describe("codex conversation turn collector", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    {
      scenario: "commentary after an answer",
      metadata: { phase: "commentary", delivery: null },
      replyText: "real answer",
    },
    {
      scenario: "async-only",
      metadata: { phase: "final_answer", delivery: "async" },
      replyText: "",
    },
  ])("does not promote progress to a final answer ($scenario)", async ({ metadata, replyText }) => {
    const collector = createCodexConversationTurnCollector("thread-1");
    collector.setTurnId("turn-1");
    if (replyText) {
      collector.handleNotification({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "answer", text: replyText, phase: "final_answer" },
        },
      });
    }
    collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "progress", delta: "progress" },
    });
    collector.handleNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "progress",
          text: "completed progress",
          ...metadata,
        },
      },
    });
    collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [
            { type: "agentMessage", id: "progress", text: "completed progress", ...metadata },
          ],
        },
      },
    });

    await expect(collector.wait({ timeoutMs: 100 })).resolves.toEqual({
      replyText,
    });
  });

  it("returns the last completed final answer when the terminal summary is empty", async () => {
    const collector = createCodexConversationTurnCollector("thread-1");
    collector.setTurnId("turn-1");
    const completedAnswers: Array<{ id: string; text: string }> = [
      { id: "first", text: "first answer" },
      { id: "second", text: "second answer" },
    ];
    for (const { id, text } of completedAnswers) {
      collector.handleNotification({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id, text, phase: "final_answer" },
        },
      });
    }
    collector.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });

    await expect(collector.wait({ timeoutMs: 100 })).resolves.toEqual({
      replyText: "second answer",
    });
  });

  it("lets the terminal final answer supersede later streamed completions", async () => {
    const collector = createCodexConversationTurnCollector("thread-1");
    collector.setTurnId("turn-1");
    collector.handleNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", id: "answer", text: "earlier answer" },
      },
    });
    collector.handleNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", id: "later", text: "later answer" },
      },
    });
    collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "answer", text: "terminal answer" }],
        },
      },
    });

    await expect(collector.wait({ timeoutMs: 100 })).resolves.toEqual({
      replyText: "terminal answer",
    });
  });

  it("ignores notifications for other threads or turns", async () => {
    const collector = createCodexConversationTurnCollector("thread-1");
    collector.setTurnId("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-2", turnId: "turn-1", itemId: "wrong", delta: "wrong" },
    });
    collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-2", itemId: "wrong", delta: "wrong" },
    });
    collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "item-1", text: "right" }],
        },
      },
    });

    await expect(completion).resolves.toEqual({ replyText: "right" });
  });

  it("does not complete from unscoped turn completion once the active turn is known", async () => {
    const collector = createCodexConversationTurnCollector("thread-1");
    collector.setTurnId("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          status: "completed",
          items: [{ type: "agentMessage", id: "wrong", text: "wrong" }],
        },
      },
    });
    collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "right", text: "right" }],
        },
      },
    });

    await expect(completion).resolves.toEqual({ replyText: "right" });
  });

  it("rejects a non-terminal status instead of returning streamed partial text", async () => {
    const collector = createCodexConversationTurnCollector("thread-1");
    collector.setTurnId("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    collector.handleNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "unfinished answer",
      },
    });
    collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "inProgress", error: null, items: [] },
      },
    });

    await expect(completion).rejects.toThrow(
      "codex app-server turn completed without a valid terminal status",
    );
  });

  it("clamps oversized turn wait timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const collector = createCodexConversationTurnCollector("thread-1");
      collector.setTurnId("turn-1");
      const completion = collector.wait({ timeoutMs: MAX_TIMER_TIMEOUT_MS + 1 });

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      collector.handleNotification({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
      });

      await expect(completion).resolves.toEqual({ replyText: "" });
    } finally {
      vi.restoreAllMocks();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
