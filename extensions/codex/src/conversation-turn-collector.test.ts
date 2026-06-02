import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexConversationTurnCollector } from "./conversation-turn-collector.js";

describe("codex conversation turn collector", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("collects streamed assistant deltas for the active turn", async () => {
    const collector = createCodexConversationTurnCollector("thread-1");
    collector.setTurnId("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hello " },
    });
    collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "world" },
    });
    collector.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });

    await expect(completion).resolves.toEqual({ replyText: "hello world", planText: "" });
  });

  it("buffers pre-start notifications and replays only the selected turn", async () => {
    const collector = createCodexConversationTurnCollector("thread-1");

    collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-stale",
          status: "completed",
          items: [{ type: "agentMessage", id: "wrong", text: "stale answer" }],
        },
      },
    });
    collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "right", delta: "fresh " },
    });
    collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "right", text: "fresh answer" }],
        },
      },
    });

    collector.setTurnId("turn-1");

    await expect(collector.wait({ timeoutMs: 1_000 })).resolves.toEqual({
      replyText: "fresh answer",
      planText: "",
    });
  });

  it("uses completed agent message items when deltas are absent", async () => {
    const collector = createCodexConversationTurnCollector("thread-1");
    collector.setTurnId("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    collector.handleNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", id: "item-1", text: "final answer" },
      },
    });
    collector.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });

    await expect(completion).resolves.toEqual({ replyText: "final answer", planText: "" });
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

    await expect(completion).resolves.toEqual({ replyText: "right", planText: "" });
  });

  it("ignores unscoped deltas once the active turn is known", async () => {
    const collector = createCodexConversationTurnCollector("thread-1");
    collector.setTurnId("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", itemId: "wrong", delta: "wrong" },
    });
    collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "right", delta: "right" },
    });
    collector.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });

    await expect(completion).resolves.toEqual({ replyText: "right", planText: "" });
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

    await expect(completion).resolves.toEqual({ replyText: "right", planText: "" });
  });

  it("collects streamed and completed plan text", async () => {
    const collector = createCodexConversationTurnCollector("thread-1");
    collector.setTurnId("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    collector.handleNotification({
      method: "item/plan/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "plan-1",
        delta: "<proposed_plan>Step 1",
      },
    });
    collector.handleNotification({
      method: "item/plan/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "plan-1",
        delta: "</proposed_plan>",
      },
    });
    collector.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });

    await expect(completion).resolves.toEqual({
      replyText: "",
      planText: "<proposed_plan>Step 1</proposed_plan>",
    });
  });

  it("collects plan deltas without emitting them as live progress", async () => {
    const onProgress = vi.fn();
    const collector = createCodexConversationTurnCollector("thread-1", { onProgress });
    collector.setTurnId("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    collector.handleNotification({
      method: "item/plan/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "plan-1", delta: "# Plan" },
    });
    collector.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });

    expect(onProgress).not.toHaveBeenCalled();
    await expect(completion).resolves.toEqual({ replyText: "", planText: "# Plan" });
  });

  it("emits live progress for completed commentary and item state changes", async () => {
    const onProgress = vi.fn();
    const collector = createCodexConversationTurnCollector("thread-1", { onProgress });
    collector.setTurnId("turn-1");

    collector.handleNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "msg-1", type: "agentMessage", phase: "commentary" },
      },
    });
    collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta: "The" },
    });
    expect(onProgress).not.toHaveBeenCalledWith("Codex: The");
    collector.handleNotification({
      method: "item/plan/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "plan-1", delta: "do it" },
    });
    collector.handleNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "msg-1",
          type: "agentMessage",
          phase: "commentary",
          text: "The plan is ready.",
        },
      },
    });
    collector.handleNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "tool-1", type: "toolCall", tool: "shell" },
      },
    });

    expect(onProgress).toHaveBeenCalledWith("Codex: The plan is ready.");
    expect(onProgress).not.toHaveBeenCalledWith("Codex plan:\ndo it");
    expect(onProgress).toHaveBeenCalledWith("Codex started shell (toolCall).");
  });

  it("flushes completed commentary from terminal turn items", async () => {
    const onProgress = vi.fn();
    const collector = createCodexConversationTurnCollector("thread-1", { onProgress });
    collector.setTurnId("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    collector.handleNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "msg-1", type: "agentMessage", phase: "commentary" },
      },
    });
    collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta: "One" },
    });
    collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [
            {
              id: "msg-1",
              type: "agentMessage",
              phase: "commentary",
              text: "One issue remains.",
            },
          ],
        },
      },
    });

    expect(onProgress).not.toHaveBeenCalledWith("Codex: One");
    expect(onProgress).toHaveBeenCalledWith("Codex: One issue remains.");
    await expect(completion).resolves.toEqual({ replyText: "One issue remains.", planText: "" });
  });

  it("rejects failed turns with the app-server error message", async () => {
    const collector = createCodexConversationTurnCollector("thread-1");
    collector.setTurnId("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "failed", error: { message: "model exploded" }, items: [] },
      },
    });

    await expect(completion).rejects.toThrow("model exploded");
  });

  it("times out when the app-server never completes the turn", async () => {
    vi.useFakeTimers();
    try {
      const collector = createCodexConversationTurnCollector("thread-1");
      const completion = collector.wait({ timeoutMs: 100 });
      const assertion = expect(completion).rejects.toThrow("codex app-server bound turn timed out");
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("resets the timeout when active-turn notifications keep arriving", async () => {
    vi.useFakeTimers();
    try {
      const collector = createCodexConversationTurnCollector("thread-1");
      collector.setTurnId("turn-1");
      const completion = collector.wait({ timeoutMs: 100 });

      await vi.advanceTimersByTimeAsync(90);
      collector.handleNotification({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "tool-1", type: "toolCall", tool: "shell" },
        },
      });
      await vi.advanceTimersByTimeAsync(90);
      collector.handleNotification({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "completed",
            items: [{ type: "agentMessage", id: "answer", text: "done" }],
          },
        },
      });

      await expect(completion).resolves.toEqual({ replyText: "done", planText: "" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reset the timeout for ignored notifications", async () => {
    vi.useFakeTimers();
    try {
      const collector = createCodexConversationTurnCollector("thread-1");
      collector.setTurnId("turn-1");
      const completion = collector.wait({ timeoutMs: 100 });
      const assertion = expect(completion).rejects.toThrow("codex app-server bound turn timed out");

      await vi.advanceTimersByTimeAsync(90);
      collector.handleNotification({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-2",
          item: { id: "tool-1", type: "toolCall", tool: "shell" },
        },
      });
      await vi.advanceTimersByTimeAsync(10);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("suspends the timeout while user input is pending", async () => {
    vi.useFakeTimers();
    try {
      const collector = createCodexConversationTurnCollector("thread-1");
      collector.setTurnId("turn-1");
      const completion = collector.wait({ timeoutMs: 100 });

      await vi.advanceTimersByTimeAsync(90);
      const resume = collector.suspendTimeout();
      await vi.advanceTimersByTimeAsync(1_000);
      resume();
      await vi.advanceTimersByTimeAsync(90);
      collector.handleNotification({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "completed",
            items: [{ type: "agentMessage", id: "answer", text: "done" }],
          },
        },
      });

      await expect(completion).resolves.toEqual({ replyText: "done", planText: "" });
    } finally {
      vi.useRealTimers();
    }
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

      await expect(completion).resolves.toEqual({ replyText: "", planText: "" });
    } finally {
      vi.restoreAllMocks();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
