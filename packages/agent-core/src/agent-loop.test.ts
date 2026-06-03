import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "../../llm-core/src/index.js";
import { agentLoop, agentLoopContinue } from "./agent-loop.js";
import type { Message, Model } from "./llm.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolCall,
  StreamFn,
} from "./types.js";

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

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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

function toolCallStreamFn(toolCalls: AgentToolCall[]): StreamFn {
  let streamCalls = 0;
  return () => {
    streamCalls += 1;
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message = {
        role: "assistant",
        content:
          streamCalls === 1
            ? toolCalls
            : [
                {
                  type: "text",
                  text: "done",
                },
              ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: streamCalls === 1 ? "toolUse" : "stop",
        timestamp: streamCalls === 1 ? 2 : 4,
      } satisfies AgentMessage;
      stream.push({
        type: "done",
        reason: streamCalls === 1 ? "toolUse" : "stop",
        message,
      });
    });
    return stream;
  };
}

async function runToolLoop(
  tools: AgentTool[],
  toolCalls: AgentToolCall[],
): Promise<{ events: AgentEvent[]; result: AgentMessage[] }> {
  const stream = agentLoop(
    [{ role: "user", content: "hello", timestamp: 1 }],
    { systemPrompt: "", messages: [], tools },
    config,
    undefined,
    toolCallStreamFn(toolCalls),
  );
  return {
    events: await collectEvents(stream),
    result: await stream.result(),
  };
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

describe("agentLoop tool-call preparation", () => {
  it("executes a healthy tool when an unreadable sibling tool name is present", async () => {
    const unreadableTool = {
      get name() {
        throw new Error("tool name getter exploded");
      },
      label: "Unreadable",
      description: "Unreadable sibling",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "bad" }],
        details: undefined,
      }),
    } as unknown as AgentTool;
    const healthyTool = {
      name: "healthy_probe",
      label: "Healthy probe",
      description: "Healthy sibling",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "ok" }],
        details: undefined,
      }),
    } satisfies AgentTool;
    const { events, result } = await runToolLoop(
      [unreadableTool, healthyTool],
      [{ type: "toolCall", id: "call-1", name: "healthy_probe", arguments: {} }],
    );

    expect(result.find((message) => message.role === "toolResult")).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "healthy_probe",
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });
    expect(result.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "stop",
    });
    expect(events.map((event) => event.type)).toContain("tool_execution_end");
  });

  it("uses sequential execution when a matching tool execution mode is unreadable", async () => {
    const executionOrder: string[] = [];
    const guardedTool = {
      name: "guarded_probe",
      label: "Guarded probe",
      description: "Sequential fallback probe",
      get executionMode() {
        throw new Error("execution mode getter exploded");
      },
      parameters: Type.Object({}),
      execute: async () => {
        executionOrder.push("guarded:start");
        await Promise.resolve();
        executionOrder.push("guarded:end");
        return {
          content: [{ type: "text", text: "guarded" }],
          details: undefined,
        };
      },
    } satisfies AgentTool;
    const plainTool = {
      name: "plain_probe",
      label: "Plain probe",
      description: "Parallel-capable sibling",
      parameters: Type.Object({}),
      execute: async () => {
        executionOrder.push("plain:start");
        executionOrder.push("plain:end");
        return {
          content: [{ type: "text", text: "plain" }],
          details: undefined,
        };
      },
    } satisfies AgentTool;

    await runToolLoop(
      [guardedTool, plainTool],
      [
        { type: "toolCall", id: "call-1", name: "guarded_probe", arguments: {} },
        { type: "toolCall", id: "call-2", name: "plain_probe", arguments: {} },
      ],
    );

    expect(executionOrder).toEqual(["guarded:start", "guarded:end", "plain:start", "plain:end"]);
  });
});
