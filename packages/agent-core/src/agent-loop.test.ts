import { describe, expect, it } from "vitest";
import { agentLoop, agentLoopContinue, runAgentLoop } from "./agent-loop.js";
import { createAssistantMessageEventStream } from "./llm.js";
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

describe("agentLoop tool-call poisoning guard", () => {
  it("stops after repeated identical error tool results", async () => {
    let streamCalls = 0;
    const events: AgentEvent[] = [];
    const streamFn: StreamFn = () => {
      streamCalls += 1;
      const output = createAssistantMessageEventStream();
      queueMicrotask(() => {
        output.push({
          type: "done",
          reason: "toolUse",
          message: {
            role: "assistant",
            api: "test-api",
            provider: "test-provider",
            model: "test-model",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            content: [
              {
                type: "toolCall",
                id: `call-${streamCalls}`,
                name: "poisoned_tool",
                arguments: {},
              },
            ],
            stopReason: "toolUse",
            timestamp: Date.now(),
          },
        });
        output.end();
      });
      return output;
    };

    const result = await runAgentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [
          {
            label: "Poisoned Tool",
            name: "poisoned_tool",
            description: "Always returns a terminal error marker",
            parameters: { type: "object", properties: {} },
            execute: async () => ({
              content: [{ type: "text", text: "invalid tool request" }],
              details: { isError: true },
            }),
          },
        ],
      },
      config,
      async (event) => {
        events.push(event);
      },
      undefined,
      streamFn,
    );

    expect(streamCalls).toBe(2);
    expect(result.filter((message) => message.role === "assistant")).toHaveLength(2);
    const toolResults = result.filter((message) => message.role === "toolResult");
    expect(toolResults).toHaveLength(2);
    expect(toolResults.every((message) => message.isError === true)).toBe(true);
    expect(events.some((event) => event.type === "agent_end")).toBe(true);
  });
});

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
