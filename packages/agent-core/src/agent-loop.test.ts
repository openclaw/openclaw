import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { agentLoop, agentLoopContinue } from "./agent-loop.js";
import type { AssistantMessage, Message, Model } from "./llm.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
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

function assistantToolUse(...names: string[]): AssistantMessage {
  const content: AssistantMessage["content"] = names.map((name) => ({
    type: "toolCall",
    id: `call_${name}`,
    name,
    arguments: {},
  }));
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "toolUse",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function toolUseStreamFn(name: string): StreamFn {
  return async () => {
    const stream = createAssistantMessageEventStream();
    const message = assistantToolUse(name);
    stream.push({ type: "done", reason: "toolUse", message });
    return stream;
  };
}

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

describe("agentLoop tool descriptor isolation", () => {
  it("skips unreadable sibling tool names while executing a healthy requested tool", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: { ok: true },
      terminate: true,
    }));
    const brokenSibling = {
      get name(): string {
        throw new Error("sibling tool name exploded");
      },
      label: "Broken",
      description: "broken sibling",
      parameters: Type.Object({}),
      execute: vi.fn(),
    } as unknown as AgentTool;
    const healthyTool = {
      name: "healthy_lookup",
      label: "Healthy Lookup",
      description: "safe sibling",
      parameters: Type.Object({}),
      execute,
    } satisfies AgentTool;

    const stream = agentLoop(
      [{ role: "user", content: "call the tool", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [brokenSibling, healthyTool],
      },
      {
        ...config,
        shouldStopAfterTurn: () => true,
      },
      undefined,
      toolUseStreamFn("healthy_lookup"),
    );

    const events = await collectEvents(stream);
    const result = await stream.result();

    expect(execute).toHaveBeenCalledOnce();
    expect(result.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(result.at(-1)).toMatchObject({
      role: "toolResult",
      toolName: "healthy_lookup",
      isError: false,
    });
    expect(JSON.stringify(events)).not.toContain("sibling tool name exploded");
  });

  it("fails closed to sequential execution when a matched tool execution mode is unreadable", async () => {
    const order: string[] = [];
    const guardedTool = {
      name: "guarded_lookup",
      label: "Guarded Lookup",
      description: "mode descriptor is unreadable",
      parameters: Type.Object({}),
      get executionMode(): never {
        throw new Error("execution mode exploded");
      },
      execute: vi.fn(async () => {
        order.push("guarded:start");
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1);
        });
        order.push("guarded:end");
        return {
          content: [{ type: "text" as const, text: "guarded" }],
          details: { ok: true },
        };
      }),
    } as unknown as AgentTool;
    const siblingTool = {
      name: "sibling_lookup",
      label: "Sibling Lookup",
      description: "safe sibling",
      parameters: Type.Object({}),
      execute: vi.fn(async () => {
        order.push("sibling:start");
        return {
          content: [{ type: "text" as const, text: "sibling" }],
          details: { ok: true },
        };
      }),
    } satisfies AgentTool;

    const stream = agentLoop(
      [{ role: "user", content: "call both tools", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [guardedTool, siblingTool],
      },
      {
        ...config,
        shouldStopAfterTurn: () => true,
      },
      undefined,
      async () => {
        const messageStream = createAssistantMessageEventStream();
        const message = assistantToolUse("guarded_lookup", "sibling_lookup");
        messageStream.push({ type: "done", reason: "toolUse", message });
        return messageStream;
      },
    );

    await collectEvents(stream);
    await stream.result();

    expect(order).toEqual(["guarded:start", "guarded:end", "sibling:start"]);
  });
});
