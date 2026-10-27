import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "./app-server/protocol.js";
import { createCodexConversationTurnCollector } from "./conversation-turn-collector.js";

function createCollector() {
  const collector = createCodexConversationTurnCollector("thread-1");
  collector.setTurnId("turn-1");
  const notify = (method: string, params: JsonObject) =>
    collector.handleNotification({
      method,
      params: { threadId: "thread-1", ...params },
    });
  return {
    ...collector,
    item: (id: string, text: string, metadata: JsonObject = {}) =>
      notify("item/completed", {
        turnId: "turn-1",
        item: { type: "agentMessage", id, text, ...metadata },
      }),
    delta: (params: JsonObject) =>
      notify("item/agentMessage/delta", { turnId: "turn-1", ...params }),
    end: (turn: JsonObject = {}) =>
      notify("turn/completed", { turn: { id: "turn-1", status: "completed", items: [], ...turn } }),
  };
}

describe("codex conversation turn collector", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ["commentary after an answer", { phase: "commentary", delivery: null }, "real answer"],
    ["async-only", { phase: "final_answer", delivery: "async" }, ""],
  ] as const)(
    "does not promote progress to a final answer (%s)",
    async (_, metadata, replyText) => {
      const collector = createCollector();
      if (replyText) {
        collector.item("answer", replyText, { phase: "final_answer" });
      }
      collector.delta({ itemId: "progress", delta: "progress" });
      collector.item("progress", "completed progress", metadata);
      collector.end({
        items: [{ type: "agentMessage", id: "progress", text: "completed progress", ...metadata }],
      });

      await expect(collector.wait({ timeoutMs: 100 })).resolves.toEqual({ replyText });
    },
  );

  it.each([
    ["empty terminal summary", "final_answer", [], "second answer"],
    [
      "terminal override",
      null,
      [{ type: "agentMessage", id: "answer", text: "terminal answer" }],
      "terminal answer",
    ],
  ] satisfies [string, string | null, JsonObject[], string][])(
    "uses the last final answer with %s",
    async (_, phase, items, replyText) => {
      const collector = createCollector();
      collector.item("answer", "first answer", phase ? { phase } : {});
      collector.item("later", "second answer", phase ? { phase } : {});
      collector.end({ items });
      await expect(collector.wait({ timeoutMs: 100 })).resolves.toEqual({ replyText });
    },
  );

  it("ignores notifications for other threads or turns", async () => {
    const collector = createCollector();
    const completion = collector.wait({ timeoutMs: 1_000 });

    collector.delta({ threadId: "thread-2", itemId: "wrong", delta: "wrong" });
    collector.delta({ turnId: "turn-2", itemId: "wrong", delta: "wrong" });
    collector.end({
      items: [{ type: "agentMessage", id: "item-1", text: "right" }],
    });

    await expect(completion).resolves.toEqual({ replyText: "right" });
  });

  it("does not complete from unscoped turn completion once the active turn is known", async () => {
    const collector = createCollector();
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
    collector.end({
      items: [{ type: "agentMessage", id: "right", text: "right" }],
    });

    await expect(completion).resolves.toEqual({ replyText: "right" });
  });

  it("rejects a non-terminal status instead of returning streamed partial text", async () => {
    const collector = createCollector();
    const completion = collector.wait({ timeoutMs: 1_000 });

    collector.delta({ itemId: "item-1", delta: "unfinished answer" });
    collector.end({ status: "inProgress", error: null });

    await expect(completion).rejects.toThrow(
      "codex app-server turn completed without a valid terminal status",
    );
  });

  it("clamps oversized turn wait timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const collector = createCollector();
    const completion = collector.wait({ timeoutMs: MAX_TIMER_TIMEOUT_MS + 1 });

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    collector.end();

    await expect(completion).resolves.toEqual({ replyText: "" });
  });
});
