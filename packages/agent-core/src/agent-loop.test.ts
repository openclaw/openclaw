// Agent Core tests cover agent loop behavior.
import { describe, expect, it, vi } from "vitest";
import { agentLoop, agentLoopContinue, runAgentLoop } from "./agent-loop.js";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
} from "./llm.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolResult,
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

const TEST_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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

describe("agentLoop streaming updates", () => {
  it("rebuilds assistant message snapshots for text deltas without partial snapshots", async () => {
    const streamFn: StreamFn = async () => {
      const stream = createAssistantMessageEventStream();
      const startMessage: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      };
      const textStartMessage: AssistantMessage = { ...startMessage, content: [] };
      const finalMessage: AssistantMessage = {
        ...startMessage,
        content: [{ type: "text", text: "Hello world" }],
      };

      queueMicrotask(() => {
        stream.push({ type: "start", partial: startMessage });
        stream.push({ type: "text_start", contentIndex: 0, partial: textStartMessage });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "Hello" });
        stream.push({ type: "text_delta", contentIndex: 0, delta: " world" });
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: "Hello world",
          partial: finalMessage,
        });
        stream.push({ type: "done", reason: "stop", message: finalMessage });
      });

      return stream;
    };

    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      { systemPrompt: "", messages: [] },
      config,
      undefined,
      streamFn,
    );
    const events = await collectEvents(stream);

    const deltaUpdates = events.filter(
      (event): event is Extract<AgentEvent, { type: "message_update" }> =>
        event.type === "message_update" && event.assistantMessageEvent.type === "text_delta",
    );
    expect(deltaUpdates).toHaveLength(2);
    expect(deltaUpdates.map((event) => event.message)).toMatchObject([
      { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hello world" }] },
    ]);
    for (const update of deltaUpdates) {
      expect(update.assistantMessageEvent).not.toHaveProperty("partial");
    }
  });
});

describe("runAgentLoop deferred tool hydration", () => {
  it("hydrates an authorized deferred tool for execution and the continuation", async () => {
    const execute = vi.fn(
      async (): Promise<AgentToolResult<unknown>> => ({
        content: [{ type: "text", text: "hidden ok" }],
        details: { ok: true },
      }),
    );
    const hiddenTool: AgentTool = {
      name: "hidden_search",
      label: "hidden_search",
      description: "Hidden search tool",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      execute,
    };
    const contexts: Context[] = [];
    let streamCalls = 0;
    const streamFn: StreamFn = (_model, context) => {
      contexts.push({ ...context, tools: context.tools?.slice() });
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        streamCalls += 1;
        const message =
          streamCalls === 1
            ? {
                role: "assistant" as const,
                content: [
                  {
                    type: "toolCall" as const,
                    id: "call-hidden",
                    name: "hidden_search",
                    arguments: { query: "penguin" },
                  },
                ],
                api: "faux",
                provider: "faux",
                model: "faux-1",
                usage: TEST_USAGE,
                stopReason: "toolUse" as const,
                timestamp: Date.now(),
              }
            : {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "done" }],
                api: "faux",
                provider: "faux",
                model: "faux-1",
                usage: TEST_USAGE,
                stopReason: "stop" as const,
                timestamp: Date.now(),
              };
        stream.push({ type: "done", reason: message.stopReason, message });
      });
      return stream;
    };
    const resolveDeferredTool = vi.fn(() => hiddenTool);

    const messages = await runAgentLoop(
      [{ role: "user", content: "search penguin", timestamp: Date.now() }],
      { systemPrompt: "test", messages: [], tools: [] },
      {
        model,
        convertToLlm: (agentMessages: AgentMessage[]) => agentMessages as never,
        resolveDeferredTool,
      },
      (_event: AgentEvent) => {},
      undefined,
      streamFn,
    );

    expect(resolveDeferredTool).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      "call-hidden",
      { query: "penguin" },
      undefined,
      expect.any(Function),
    );
    expect(contexts.map((context) => context.tools?.map((tool) => tool.name) ?? [])).toEqual([
      [],
      ["hidden_search"],
    ]);
    expect(messages.some((message) => message.role === "toolResult")).toBe(true);
  });

  it("hydrates sequential deferred tools before choosing the executor", async () => {
    let activeExecutions = 0;
    let maxActiveExecutions = 0;
    const execute = vi.fn(async (): Promise<AgentToolResult<unknown>> => {
      activeExecutions += 1;
      maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
      activeExecutions -= 1;
      return {
        content: [{ type: "text", text: "hidden ok" }],
        details: { ok: true },
      };
    });
    const hiddenTool: AgentTool = {
      name: "hidden_serial",
      label: "hidden_serial",
      description: "Hidden sequential tool",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      executionMode: "sequential",
      execute,
    };
    let streamCalls = 0;
    const streamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        streamCalls += 1;
        const message =
          streamCalls === 1
            ? {
                role: "assistant" as const,
                content: [
                  {
                    type: "toolCall" as const,
                    id: "call-hidden-1",
                    name: "hidden_serial",
                    arguments: { query: "one" },
                  },
                  {
                    type: "toolCall" as const,
                    id: "call-hidden-2",
                    name: "hidden_serial",
                    arguments: { query: "two" },
                  },
                ],
                api: "faux",
                provider: "faux",
                model: "faux-1",
                usage: TEST_USAGE,
                stopReason: "toolUse" as const,
                timestamp: Date.now(),
              }
            : {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "done" }],
                api: "faux",
                provider: "faux",
                model: "faux-1",
                usage: TEST_USAGE,
                stopReason: "stop" as const,
                timestamp: Date.now(),
              };
        stream.push({ type: "done", reason: message.stopReason, message });
      });
      return stream;
    };
    const resolveDeferredTool = vi.fn(() => hiddenTool);

    await runAgentLoop(
      [{ role: "user", content: "search twice", timestamp: Date.now() }],
      { systemPrompt: "test", messages: [], tools: [] },
      {
        model,
        convertToLlm: (agentMessages: AgentMessage[]) => agentMessages as never,
        resolveDeferredTool,
      },
      (_event: AgentEvent) => {},
      undefined,
      streamFn,
    );

    expect(resolveDeferredTool).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(maxActiveExecutions).toBe(1);
  });
});

describe("agentLoop thinking state", () => {
  function makeAssistantMessage(
    activeModel: Model,
    content: AssistantMessage["content"],
  ): AssistantMessage {
    return {
      role: "assistant",
      content,
      api: activeModel.api,
      provider: activeModel.provider,
      model: activeModel.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    };
  }

  it.each([
    {
      name: "disables reasoning after leaving Fable",
      initialModel: { ...model, id: "claude-fable-5", thinkingLevelMap: { off: "low" } },
      nextModel: model,
      expected: ["low", undefined],
    },
    {
      name: "uses Fable's low fallback after entering Fable",
      initialModel: model,
      nextModel: { ...model, id: "claude-fable-5", thinkingLevelMap: { off: "low" } },
      expected: [undefined, "low"],
    },
  ])("$name", async ({ initialModel, nextModel, expected }) => {
    const observedReasoning: Array<string | undefined> = [];
    let callCount = 0;
    const streamFn: StreamFn = (activeModel, _context, options) => {
      observedReasoning.push(options?.reasoning);
      callCount += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const content: AssistantMessage["content"] =
          callCount === 1
            ? [{ type: "toolCall", id: "tool-1", name: "missing_tool", arguments: {} }]
            : [{ type: "text", text: "done" }];
        stream.push({
          type: "done",
          reason: "stop",
          message: makeAssistantMessage(activeModel, content),
        });
        stream.end();
      });
      return stream;
    };
    let prepared = false;
    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      { systemPrompt: "", messages: [] },
      {
        ...config,
        model: initialModel,
        thinkingLevel: "off",
        reasoning: initialModel.thinkingLevelMap?.off === "low" ? "low" : undefined,
        prepareNextTurn: () => {
          if (prepared) {
            return undefined;
          }
          prepared = true;
          return { model: nextModel };
        },
      },
      undefined,
      streamFn,
    );

    await collectEvents(stream);

    expect(observedReasoning).toEqual(expected);
  });
});
