import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { createUsageAccumulator, mergeUsageIntoAccumulator } from "../usage-accumulator.js";
import { buildErrorAgentMeta, resolveFinalAssistantVisibleText } from "./helpers.js";

function makeAssistantMessage(
  content: AssistantMessage["content"],
  phase?: string,
): AssistantMessage {
  return {
    api: "responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    role: "assistant",
    content,
    timestamp: Date.now(),
    stopReason: "stop",
    ...(phase ? { phase } : {}),
  };
}

describe("resolveFinalAssistantVisibleText", () => {
  it("prefers final_answer text over commentary blocks", () => {
    const lastAssistant = makeAssistantMessage([
      {
        type: "text",
        text: "Working...",
        textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
      },
      {
        type: "text",
        text: "Section 1\nSection 2",
        textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
      },
    ]);

    expect(resolveFinalAssistantVisibleText(lastAssistant)).toBe("Section 1\nSection 2");
  });

  it("returns undefined when the final visible text is empty", () => {
    const lastAssistant = makeAssistantMessage([
      {
        type: "text",
        text: "Working...",
        textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
      },
      {
        type: "text",
        text: "   ",
        textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
      },
    ]);

    expect(resolveFinalAssistantVisibleText(lastAssistant)).toBeUndefined();
  });
});

describe("buildErrorAgentMeta", () => {
  it("preserves upstream request ids in error agent meta", () => {
    const usageAccumulator = createUsageAccumulator();
    mergeUsageIntoAccumulator(usageAccumulator, {
      input: 12,
      output: 3,
      total: 15,
    });

    const meta = buildErrorAgentMeta({
      sessionId: "session-1",
      provider: "openai",
      model: "gpt-5.4",
      usageAccumulator,
      lastRunPromptUsage: { input: 12, output: 3, total: 15 },
      lastAssistant: {
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          totalTokens: 15,
        },
        upstreamRequestId: " req_err_123 ",
      },
      lastTurnTotal: 15,
    });

    expect(meta.upstreamRequestId).toBe("req_err_123");
    expect(meta.usage).toMatchObject({ total: 15 });
  });
});
