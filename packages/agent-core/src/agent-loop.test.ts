// Agent Core tests cover agent loop behavior.
import { Type } from "typebox";
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
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
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

  it("resolves a missing deferred tool once across pre-scan and preparation", async () => {
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
                    id: "call-missing",
                    name: "missing_deferred",
                    arguments: {},
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
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
      });
      return stream;
    };
    const resolveDeferredTool = vi.fn(() => undefined);

    const messages = await runAgentLoop(
      [{ role: "user", content: "call missing tool", timestamp: Date.now() }],
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
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolName: "missing_deferred",
        isError: true,
      }),
    );
  });

  it("converts deferred resolver failures into one error tool result", async () => {
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
                    id: "call-failing-deferred",
                    name: "failing_deferred",
                    arguments: {},
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
    const resolveDeferredTool = vi.fn(async () => {
      throw new Error("deferred hydration failed");
    });

    const messages = await runAgentLoop(
      [{ role: "user", content: "call failing tool", timestamp: Date.now() }],
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
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolName: "failing_deferred",
        isError: true,
        content: [{ type: "text", text: "deferred hydration failed" }],
      }),
    );
  });

  it("rejects deferred tools whose names differ from the requested call", async () => {
    const execute = vi.fn(
      async (): Promise<AgentToolResult<unknown>> => ({
        content: [{ type: "text", text: "wrong tool ran" }],
        details: { ok: true },
      }),
    );
    const mismatchedTool: AgentTool = {
      name: "other_deferred",
      label: "other_deferred",
      description: "Different deferred tool",
      parameters: Type.Object({}, { additionalProperties: false }),
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
                    id: "call-requested-deferred",
                    name: "requested_deferred",
                    arguments: {},
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

    const messages = await runAgentLoop(
      [{ role: "user", content: "call requested tool", timestamp: Date.now() }],
      { systemPrompt: "test", messages: [], tools: [] },
      {
        model,
        convertToLlm: (agentMessages: AgentMessage[]) => agentMessages as never,
        resolveDeferredTool: () => mismatchedTool,
      },
      (_event: AgentEvent) => {},
      undefined,
      streamFn,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(contexts.map((context) => context.tools?.map((tool) => tool.name) ?? [])).toEqual([
      [],
      [],
    ]);
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolName: "requested_deferred",
        isError: true,
        content: [
          {
            type: "text",
            text: 'Deferred tool resolver returned "other_deferred" for requested "requested_deferred"',
          },
        ],
      }),
    );
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

describe("agentLoop tool termination", () => {
  function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
    return {
      role: "assistant",
      content,
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
      stopReason: content.some((item) => item.type === "toolCall") ? "toolUse" : "stop",
      timestamp: 1,
    };
  }

  function makeTool(name: string, executed: string[]): AgentTool {
    return {
      name,
      label: name,
      description: name,
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        executed.push(name);
        return {
          content: [{ type: "text", text: `${name} result` }],
          details: { name },
        };
      },
    };
  }

  it("continues after a side-effect tool result when afterToolCall records it without terminate", async () => {
    const executed: string[] = [];
    let turn = 0;
    const streamFn: StreamFn = () => {
      turn += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          turn === 1
            ? makeAssistantMessage([
                { type: "toolCall", id: "call-message", name: "message", arguments: {} },
              ])
            : turn === 2
              ? makeAssistantMessage([
                  { type: "toolCall", id: "call-exec", name: "exec", arguments: {} },
                ])
              : makeAssistantMessage([{ type: "text", text: "done" }]);
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    };
    let recordedSideEffect = false;

    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [makeTool("message", executed), makeTool("exec", executed)],
      },
      {
        ...config,
        afterToolCall: async ({ toolCall }) => {
          if (toolCall.name === "message") {
            recordedSideEffect = true;
          }
          return undefined;
        },
      },
      undefined,
      streamFn,
    );

    const events = await collectEvents(stream);

    expect(recordedSideEffect).toBe(true);
    expect(turn).toBe(3);
    expect(executed).toEqual(["message", "exec"]);
    expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(2);
    expect(
      events
        .filter(
          (event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
            event.type === "tool_execution_end",
        )
        .map((event) => event.executionStarted),
    ).toEqual([true, true]);
    expect(events.at(-1)).toMatchObject({ type: "agent_end" });
  });

  it("marks policy-blocked tool calls as not executed", async () => {
    const executed: string[] = [];
    let turn = 0;
    const streamFn: StreamFn = () => {
      turn += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          turn === 1
            ? makeAssistantMessage([
                { type: "toolCall", id: "call-cron", name: "cron", arguments: {} },
              ])
            : makeAssistantMessage([{ type: "text", text: "done" }]);
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    };

    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [makeTool("cron", executed)],
      },
      {
        ...config,
        beforeToolCall: async () => ({ block: true, reason: "blocked" }),
      },
      undefined,
      streamFn,
    );

    const events = await collectEvents(stream);
    const endEvent = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
        event.type === "tool_execution_end",
    );

    expect(executed).toEqual([]);
    expect(endEvent?.executionStarted).toBe(false);
  });

  it("stops after a tool result only when the finalized result explicitly terminates", async () => {
    const executed: string[] = [];
    let turn = 0;
    const streamFn: StreamFn = () => {
      turn += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          turn === 1
            ? makeAssistantMessage([
                { type: "toolCall", id: "call-message", name: "message", arguments: {} },
              ])
            : makeAssistantMessage([
                { type: "toolCall", id: "call-exec", name: "exec", arguments: {} },
              ]);
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end();
      });
      return stream;
    };

    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [makeTool("message", executed), makeTool("exec", executed)],
      },
      {
        ...config,
        afterToolCall: async ({ toolCall }) =>
          toolCall.name === "message" ? { terminate: true } : undefined,
      },
      undefined,
      streamFn,
    );

    const events = await collectEvents(stream);

    expect(turn).toBe(1);
    expect(executed).toEqual(["message"]);
    expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "agent_end" });
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
