// Codex tests cover conversation turn collector plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexTerminalTextCollector } from "./conversation-turn-collector.js";

describe("codex terminal text collector", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("collects streamed assistant deltas for the active turn", async () => {
    const collector = createCodexTerminalTextCollector("thread-1");
    collector.bindTurn("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    await collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hello " },
    });
    await collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "world" },
    });
    await collector.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });

    await expect(completion).resolves.toEqual({ replyText: "hello world" });
  });

  it("uses completed agent message items when deltas are absent", async () => {
    const collector = createCodexTerminalTextCollector("thread-1");
    collector.bindTurn("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    await collector.handleNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", id: "item-1", text: "final answer" },
      },
    });
    await collector.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });

    await expect(completion).resolves.toEqual({ replyText: "final answer" });
  });

  it("prefers the final answer over commentary when the terminal turn has no items", async () => {
    const collector = createCodexTerminalTextCollector("thread-1");
    collector.bindTurn("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    await collector.handleNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "commentary-1",
          text: "Still working.",
          phase: "commentary",
        },
      },
    });
    await collector.handleNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "final-1",
          text: "Final answer.",
          phase: "final_answer",
        },
      },
    });
    await collector.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });

    await expect(completion).resolves.toEqual({ replyText: "Final answer." });
    expect(collector.completed).toBe(true);
  });

  it("ignores notifications for other threads or turns", async () => {
    const collector = createCodexTerminalTextCollector("thread-1");
    collector.bindTurn("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    await collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-2", turnId: "turn-1", itemId: "wrong", delta: "wrong" },
    });
    await collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-2", itemId: "wrong", delta: "wrong" },
    });
    await collector.handleNotification({
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

  it("ignores unscoped deltas once the active turn is known", async () => {
    const collector = createCodexTerminalTextCollector("thread-1");
    collector.bindTurn("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    await collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", itemId: "wrong", delta: "wrong" },
    });
    await collector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "right", delta: "right" },
    });
    await collector.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });

    await expect(completion).resolves.toEqual({ replyText: "right" });
  });

  it("does not complete from unscoped turn completion once the active turn is known", async () => {
    const collector = createCodexTerminalTextCollector("thread-1");
    collector.bindTurn("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    await collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          status: "completed",
          items: [{ type: "agentMessage", id: "wrong", text: "wrong" }],
        },
      },
    });
    await collector.handleNotification({
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

  it("rejects failed turns with the app-server error message", async () => {
    const collector = createCodexTerminalTextCollector("thread-1");
    collector.bindTurn("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    await collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "failed", error: { message: "model exploded" }, items: [] },
      },
    });

    await expect(completion).rejects.toThrow("model exploded");
  });

  it("lets callers format interrupted turns while retaining terminal completion state", async () => {
    const formatError = vi.fn(() => "custom interrupted error");
    const collector = createCodexTerminalTextCollector("thread-1", { formatError });
    collector.bindTurn("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    await collector.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", items: [] } },
    });

    await expect(completion).rejects.toThrow("custom interrupted error");
    expect(formatError).toHaveBeenCalledWith({
      kind: "turn-interrupted",
      turn: { id: "turn-1", status: "interrupted", items: [] },
    });
    expect(collector.completed).toBe(true);
  });

  it("uses a terminal turn/start response without waiting for a notification", async () => {
    const collector = createCodexTerminalTextCollector("thread-1");
    collector.bindTurn("turn-1", {
      id: "turn-1",
      status: "completed",
      items: [{ id: "item-1", type: "agentMessage", text: "already complete" }],
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    });

    await expect(collector.wait({ timeoutMs: 1_000 })).resolves.toEqual({
      replyText: "already complete",
    });
  });

  it("surfaces correlated error notifications with the caller's task label", async () => {
    const collector = createCodexTerminalTextCollector("thread-1", {
      taskLabel: "image understanding",
    });
    collector.bindTurn("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    await collector.handleNotification({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        error: { message: "vision unavailable" },
      },
    });

    await expect(completion).rejects.toThrow("vision unavailable");
  });

  it("ignores retryable error notifications until the turn completes", async () => {
    const collector = createCodexTerminalTextCollector("thread-1");
    collector.bindTurn("turn-1");
    const completion = collector.wait({ timeoutMs: 1_000 });

    await collector.handleNotification({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        error: { message: "temporary stream failure" },
        willRetry: true,
      },
    });
    await collector.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "item-1", text: "recovered" }],
        },
      },
    });

    await expect(completion).resolves.toEqual({ replyText: "recovered" });
  });

  it("times out when the app-server never completes the turn", async () => {
    vi.useFakeTimers();
    try {
      const collector = createCodexTerminalTextCollector("thread-1");
      const completion = collector.wait({ timeoutMs: 100 });
      const assertion = expect(completion).rejects.toThrow("codex app-server bound turn timed out");
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("settles immediately when the owning route closes", async () => {
    const collector = createCodexTerminalTextCollector("thread-1");
    const route = new AbortController();
    const completion = collector.wait({ timeoutMs: 20 * 60_000, signal: route.signal });

    route.abort(new Error("codex app-server turn router closed"));

    await expect(completion).rejects.toThrow("codex app-server turn router closed");
  });

  it("clamps oversized turn wait timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const collector = createCodexTerminalTextCollector("thread-1");
      collector.bindTurn("turn-1");
      const completion = collector.wait({ timeoutMs: MAX_TIMER_TIMEOUT_MS + 1 });

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      await collector.handleNotification({
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
