/**
 * Tests for ConversationStack (Rolling Summary)
 *
 * The Rolling Summary technique compresses each conversation turn into
 * ~30-word summaries and accumulates them into a session stack.
 * This allows extracting facts from long conversations without exceeding
 * the model's context window (e.g., 15k tokens).
 *
 * References:
 *  - MemGPT (Packer et al., UC Berkeley, 2023)
 *  - "Recursively Summarizing Enables Long-Term Dialogue Memory" (Wang et al., 2023)
 */

import { describe, it, expect, vi } from "vitest";
import { ConversationStack } from "./stack.js";

// Mock ChatModel that returns predictable compressed summaries
function createMockChatModel(responses?: string[]) {
  let callIndex = 0;
  const defaultResponse = "User discussed topic. Assistant provided help.";
  return {
    complete: vi.fn(async () => {
      if (responses && callIndex < responses.length) {
        return responses[callIndex++];
      }
      return defaultResponse;
    }),
  };
}

describe("ConversationStack", () => {
  it("starts empty with zero turns", () => {
    const stack = new ConversationStack();
    expect(stack.turnCount).toBe(0);
    expect(stack.getSummary()).toBe("");
    expect(stack.isEmpty).toBe(true);
  });

  it("pushes a single turn and compresses it", async () => {
    const mock = createMockChatModel(["Vova asked about memory plugin architecture."]);
    const stack = new ConversationStack();

    await stack.push(
      "Як працює архітектура плагіну пам'яті?",
      "Плагін використовує LanceDB для векторного пошуку...",
      mock as any,
    );

    expect(stack.turnCount).toBe(1);
    expect(stack.isEmpty).toBe(false);
    expect(mock.complete).toHaveBeenCalledTimes(1);

    const summary = stack.getSummary();
    expect(summary).toContain("Vova asked about memory plugin architecture");
  });

  it("accumulates multiple turns into a stack", async () => {
    const mock = createMockChatModel([
      "Turn 1: User asked about bugs.",
      "Turn 2: User requested feature list.",
      "Turn 3: User approved the plan.",
    ]);
    const stack = new ConversationStack();

    await stack.push("Які баги є?", "Ось список...", mock as any);
    await stack.push("Які фічі є?", "Ось фічі...", mock as any);
    await stack.push("Ок, погнали!", "Починаю...", mock as any);

    expect(stack.turnCount).toBe(3);
    expect(mock.complete).toHaveBeenCalledTimes(3);

    const summary = stack.getSummary();
    expect(summary).toContain("Turn 1");
    expect(summary).toContain("Turn 2");
    expect(summary).toContain("Turn 3");
  });

  it("limits stack size to maxTurns", async () => {
    const mock = createMockChatModel();
    const stack = new ConversationStack(3); // max 3 turns

    for (let i = 0; i < 5; i++) {
      await stack.push(`Question ${i}`, `Answer ${i}`, mock as any);
    }

    // Should only keep last 3 turns
    expect(stack.turnCount).toBe(3);
    expect(mock.complete).toHaveBeenCalledTimes(5);
  });

  it("handles LLM failure gracefully with fallback", async () => {
    const mock = {
      complete: vi.fn(async () => {
        throw new Error("API rate limit");
      }),
    };
    const stack = new ConversationStack();

    // Should not throw — use messages longer than 10 chars to pass trivial filter
    await stack.push(
      "Tell me about the memory system architecture",
      "Here is how it works in detail",
      mock as any,
    );

    expect(stack.turnCount).toBe(1);
    const summary = stack.getSummary();
    // Fallback should contain truncated original text
    expect(summary.length).toBeGreaterThan(0);
  });

  it("skips trivial messages (too short)", async () => {
    const mock = createMockChatModel();
    const stack = new ConversationStack();

    await stack.push("ok", "👍", mock as any);

    // Trivial messages should not trigger LLM call
    expect(mock.complete).not.toHaveBeenCalled();
    expect(stack.turnCount).toBe(0);
  });

  it("produces a conversation block suitable for fact extraction", async () => {
    const mock = createMockChatModel([
      "User shared their name is Vova and they build AI bots.",
      "User explained they work at night and prefer dark themes.",
    ]);
    const stack = new ConversationStack();

    await stack.push(
      "Мене звати Вова, я будую АІ ботів",
      "Приємно познайомитись, Вова!",
      mock as any,
    );
    await stack.push("Я працюю вночі і люблю темні теми", "Зрозумів, збережу це", mock as any);

    const block = stack.getContextBlock();
    expect(block).toContain("<conversation-summary>");
    expect(block).toContain("</conversation-summary>");
    expect(block).toContain("Vova");
  });

  it("reset() clears all turns", async () => {
    const mock = createMockChatModel(["Some summary."]);
    const stack = new ConversationStack();

    await stack.push(
      "Tell me about architecture patterns",
      "Here is the full explanation of patterns",
      mock as any,
    );
    expect(stack.turnCount).toBe(1);

    stack.reset();
    expect(stack.turnCount).toBe(0);
    expect(stack.isEmpty).toBe(true);
    expect(stack.getSummary()).toBe("");
  });
});
