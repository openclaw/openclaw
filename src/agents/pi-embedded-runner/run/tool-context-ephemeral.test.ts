import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createEphemeralToolContextWrapper } from "./tool-context-ephemeral.js";

function makeAssistantTextMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function makeToolRound(round: number): AgentMessage[] {
  return [
    {
      role: "assistant",
      content: [
        { type: "text", text: `round-${round} planning` },
        {
          type: "toolCall",
          id: `call-${round}`,
          name: "bash",
          arguments: { command: `echo ${round}` },
        },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    } as AgentMessage,
    {
      role: "toolResult",
      toolCallId: `call-${round}`,
      toolName: "bash",
      content: [{ type: "text", text: `result-${round}` }],
      isError: false,
      timestamp: Date.now(),
    } as AgentMessage,
  ];
}

function makeContext(rounds: number): Parameters<StreamFn>[1] {
  const messages: AgentMessage[] = [
    {
      role: "user",
      content: "run tool chain",
      timestamp: Date.now(),
    } as AgentMessage,
  ];
  for (let i = 1; i <= rounds; i += 1) {
    messages.push(...makeToolRound(i));
  }
  return {
    systemPrompt: "base system",
    messages,
  };
}

describe("createEphemeralToolContextWrapper", () => {
  const model = {
    id: "claude-sonnet-4",
    name: "Claude",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "",
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  } as Parameters<StreamFn>[0];

  it("does not summarize when rounds are below threshold", async () => {
    const calls: Array<{ context: Parameters<StreamFn>[1] }> = [];
    const base = vi.fn(async (_model, context) => {
      calls.push({ context });
      return {
        result: async () => makeAssistantTextMessage("ok"),
      };
    }) as unknown as StreamFn;

    const wrapped = createEphemeralToolContextWrapper(base, {
      triggerRounds: 4,
      keepRecentRounds: 1,
    });

    const stream = await Promise.resolve(wrapped(model, makeContext(3), {}));
    await stream.result();

    expect(calls).toHaveLength(1);
    const sentMessages = (calls[0].context as { messages?: AgentMessage[] }).messages ?? [];
    expect(sentMessages).toHaveLength(7);
  });

  it("summarizes and prunes older rounds once threshold is reached", async () => {
    const calls: Array<{
      context: Parameters<StreamFn>[1];
      options?: Parameters<StreamFn>[2];
    }> = [];
    const base = vi.fn(async (_model, context, options) => {
      calls.push({ context, options });
      if (calls.length === 1) {
        return {
          result: async () => makeAssistantTextMessage("- summarized tool history"),
        };
      }
      return {
        result: async () => makeAssistantTextMessage("ok"),
      };
    }) as unknown as StreamFn;

    const wrapped = createEphemeralToolContextWrapper(base, {
      triggerRounds: 3,
      keepRecentRounds: 1,
    });

    const stream = await Promise.resolve(wrapped(model, makeContext(4), {}));
    await stream.result();

    // 1st call: summary sub-call, 2nd call: actual model call
    expect(calls).toHaveLength(2);
    const summaryCallContext = calls[0].context as {
      systemPrompt?: string;
      messages?: AgentMessage[];
      tools?: unknown[];
    };
    const summaryCallOptions = calls[0].options as { toolChoice?: string } | undefined;
    expect(summaryCallContext.tools).toEqual([]);
    expect(summaryCallOptions?.toolChoice).toBe("none");
    const mainCallContext = calls[1].context as {
      systemPrompt?: string;
      messages?: AgentMessage[];
    };
    expect(mainCallContext.systemPrompt).toContain("Compressed tool execution history");
    expect(mainCallContext.systemPrompt).toContain("summarized tool history");
    expect(mainCallContext.messages).toHaveLength(3); // user + last round assistant/toolResult
  });

  it("falls back to original context when summary generation fails", async () => {
    const calls: Array<{ context: Parameters<StreamFn>[1] }> = [];
    const base = vi.fn(async (_model, context) => {
      calls.push({ context });
      if (calls.length === 1) {
        return {
          result: async () => {
            throw new Error("summary failed");
          },
        };
      }
      return {
        result: async () => makeAssistantTextMessage("ok"),
      };
    }) as unknown as StreamFn;

    const wrapped = createEphemeralToolContextWrapper(base, {
      triggerRounds: 3,
      keepRecentRounds: 1,
    });

    const stream = await Promise.resolve(wrapped(model, makeContext(4), {}));
    await stream.result();

    expect(calls).toHaveLength(2);
    const mainCallContext = calls[1].context as {
      systemPrompt?: string;
      messages?: AgentMessage[];
    };
    expect(mainCallContext.systemPrompt).toBe("base system");
    expect(mainCallContext.messages).toHaveLength(9);
  });

  it("batches summary updates to avoid one extra LLM call per new round", async () => {
    const calls: Array<{ context: Parameters<StreamFn>[1] }> = [];
    const base = vi.fn(async (_model, context) => {
      calls.push({ context });
      if (calls.length === 1 || calls.length === 4) {
        return {
          result: async () => makeAssistantTextMessage("- summarized tool history"),
        };
      }
      return {
        result: async () => makeAssistantTextMessage("ok"),
      };
    }) as unknown as StreamFn;

    const wrapped = createEphemeralToolContextWrapper(base, {
      triggerRounds: 3,
      keepRecentRounds: 1,
      summaryBatchRounds: 3,
    });

    // First threshold crossing: summary + main
    const stream1 = await Promise.resolve(wrapped(model, makeContext(4), {}));
    await stream1.result();
    expect(calls).toHaveLength(2);

    // +1 round only (pending < batch): no summary, main only
    const stream2 = await Promise.resolve(wrapped(model, makeContext(5), {}));
    await stream2.result();
    expect(calls).toHaveLength(3);

    // Reach batch size pending again: summary + main
    const stream3 = await Promise.resolve(wrapped(model, makeContext(7), {}));
    await stream3.result();
    expect(calls).toHaveLength(5);
  });

  it("uses default trigger threshold of 4 rounds", async () => {
    const calls: Array<{ context: Parameters<StreamFn>[1] }> = [];
    const base = vi.fn(async (_model, context) => {
      calls.push({ context });
      if (calls.length === 1) {
        return {
          result: async () => makeAssistantTextMessage("- summarized tool history"),
        };
      }
      return {
        result: async () => makeAssistantTextMessage("ok"),
      };
    }) as unknown as StreamFn;

    const wrapped = createEphemeralToolContextWrapper(base);
    const stream = await Promise.resolve(wrapped(model, makeContext(4), {}));
    await stream.result();

    // summary sub-call + main call once round count reaches default threshold
    expect(calls).toHaveLength(2);
  });
});
