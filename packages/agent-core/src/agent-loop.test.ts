import { describe, expect, it } from "vitest";
import { agentLoop, agentLoopContinue } from "./agent-loop.js";
import type { Message, Model } from "./llm.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, StreamFn } from "./types.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

const config: AgentLoopConfig = {
  model,
  convertToLlm: (messages) => messages as Message[],
};

const failingStreamFn: StreamFn = async () => {
  throw new Error("provider exploded");
};

async function collectEvents(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function expectTerminalFailure(events: AgentEvent[], result: AgentMessage[]): void {
  expect(events.map((event) => event.type)).toContain("agent_end");
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    role: "assistant",
    stopReason: "error",
    errorMessage: "provider exploded",
  });
}

describe("agentLoop EventStream failures", () => {
  it("ends the public stream when a new prompt run rejects", async () => {
    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      { systemPrompt: "", messages: [] },
      config,
      undefined,
      failingStreamFn,
    );

    const events = await collectEvents(stream);
    const result = await stream.result();

    expectTerminalFailure(events, result);
  });

  it("ends the public stream when a continue run rejects", async () => {
    const context: AgentContext = {
      systemPrompt: "",
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    };
    const stream = agentLoopContinue(context, config, undefined, failingStreamFn);

    const events = await collectEvents(stream);
    const result = await stream.result();

    expectTerminalFailure(events, result);
  });
});

describe("agentLoop tool result error types", () => {
  function createFakeStream(assistantMessage: any) {
    return {
      async result() {
        return assistantMessage;
      },
      async *[Symbol.asyncIterator]() {
        yield { type: "start", partial: assistantMessage };
        yield { type: "done" };
      },
    } as any;
  }

  it("populates errorType 'tool_not_found' when calling a non-existent tool", async () => {
    const assistantMessage = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_not_found",
          name: "non_existent_tool",
          arguments: {},
        },
      ],
      api: "test-api",
      provider: "test-provider",
      model: "test-model",
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "toolUse",
      timestamp: Date.now(),
    };

    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      { systemPrompt: "", messages: [], tools: [] },
      config,
      undefined,
      async () => createFakeStream(assistantMessage),
    );

    const result = await stream.result();
    const toolResultMsg = result.find((msg) => msg.role === "toolResult") as any;

    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg.isError).toBe(true);
    expect(toolResultMsg.errorType).toBe("tool_not_found");
  });

  it("populates errorType 'errored' when a tool execution throws an error", async () => {
    const assistantMessage = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_explode",
          name: "explode_tool",
          arguments: {},
        },
      ],
      api: "test-api",
      provider: "test-provider",
      model: "test-model",
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "toolUse",
      timestamp: Date.now(),
    };

    const explodeTool = {
      name: "explode_tool",
      description: "A tool that throws an error",
      parameters: { type: "object", properties: {} },
      label: "Explode Tool",
      async execute() {
        throw new Error("Tool execution failed");
      },
    } as any;

    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      { systemPrompt: "", messages: [], tools: [explodeTool] },
      config,
      undefined,
      async () => createFakeStream(assistantMessage),
    );

    const result = await stream.result();
    const toolResultMsg = result.find((msg) => msg.role === "toolResult") as any;

    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg.isError).toBe(true);
    expect(toolResultMsg.errorType).toBe("errored");
  });
});
