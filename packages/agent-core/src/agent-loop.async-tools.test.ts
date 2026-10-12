import { setImmediate } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import type { AssistantMessage, Context, Model, ToolCall } from "@openclaw/llm-core";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { createRequesterYieldCallback } from "../../../src/agents/openclaw-tools.requester-yield.js";
import { isToolResultError } from "../../../src/agents/tool-result-error.js";
import { createSessionsYieldTool } from "../../../src/agents/tools/sessions-yield-tool.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { runAgentLoop } from "./agent-loop.js";
import { Agent } from "./agent.js";
import { attachInternalToolBatchLifecycle } from "./internal-hooks.js";
import { getAgentToolExecutionContext } from "./tool-execution-context.js";
import type { AgentEvent, AgentMessage, AgentTool, StreamFn } from "./types.js";

const model: Model = {
  id: "async-model",
  name: "Async Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};
const usage = {
  input: 4,
  output: 3,
  cacheRead: 2,
  cacheWrite: 0,
  totalTokens: 9,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    stopReason,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    timestamp: 1,
  };
}
function tool(name: string, execute: AgentTool["execute"]): AgentTool {
  return { name, label: name, description: name, parameters: Type.Object({}), execute };
}
function call(id: string, async = true): ToolCall {
  return { type: "toolCall", name: id, id, arguments: {}, ...(async ? { async: true } : {}) };
}
function recordMessage(event: AgentEvent, messages: AgentMessage[]) {
  if (event.type === "message_end") {
    messages.push(event.message);
  }
}

it.each(["batch", "streamed", "terminal-async", "terminal-sync", "replay"] as const)(
  "executes each duplicate-id tool occurrence (%s)",
  async (mode) => {
    const streamed = mode !== "batch";
    const response = createAssistantMessageEventStream();
    const calls = [
      { ...call("reused-provider-id", streamed), name: "first" },
      { ...call("reused-provider-id", streamed && mode !== "terminal-sync"), name: "second" },
    ];
    const first = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "first result" }],
      details: {},
    }));
    const second = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "second result" }],
      details: {},
    }));
    const persisted: AgentMessage[] = [];
    let requests = 0;
    const run = runAgentLoop(
      [{ role: "user", content: "execute both calls", timestamp: 0 }],
      { systemPrompt: "", messages: [], tools: [tool("first", first), tool("second", second)] },
      { model, convertToLlm: (messages) => messages as Context["messages"] },
      (event) => recordMessage(event, persisted),
      undefined,
      () => {
        if (++requests === 1) {
          return response;
        }
        const final = createAssistantMessageEventStream();
        final.push({ type: "done", reason: "stop", message: assistant([]) });
        final.end();
        return final;
      },
    );
    response.push({ type: "start", partial: assistant([]) });
    if (streamed) {
      for (const [contentIndex, toolCall] of calls.entries()) {
        if (contentIndex > 0 && mode.startsWith("terminal-")) {
          break;
        }
        const event = {
          type: "toolcall_end" as const,
          contentIndex,
          toolCall,
          partial: assistant(
            calls.slice(0, contentIndex + 1).map((item) => Object.assign({}, item)),
          ),
        };
        response.push(event);
        if (mode === "replay") {
          response.push(event);
        }
      }
    }
    response.push({
      type: "done",
      reason: "toolUse",
      message: assistant(
        calls.map((item) => Object.assign({}, item)),
        "toolUse",
      ),
    });
    response.end();
    const result = await run;
    expect(result).toEqual(persisted);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(result.filter((message) => message.role === "toolResult")).toMatchObject([
      {
        toolCallId: "reused-provider-id",
        toolName: "first",
        content: [{ type: "text", text: "first result" }],
        isError: false,
      },
      {
        toolCallId: "reused-provider-id",
        toolName: "second",
        content: [{ type: "text", text: "second result" }],
        isError: false,
      },
    ]);
  },
);

it.each(["mixed-parallel", "deferred-exclusive"] as const)(
  "preserves %s scheduling for streamed async calls",
  async (mode) => {
    const response = createAssistantMessageEventStream();
    const preparing = createDeferred();
    const prepared = createDeferred();
    const firstDone = createDeferred();
    const secondDone = createDeferred();
    const toolStarted = {
      first: createDeferred(),
      second: createDeferred(),
      third: createDeferred(),
    };
    const assistantFragmentsPersisted = createDeferred();
    const secondResultPersisted = createDeferred();
    // Keep the former vi.waitFor deadline without its 50 ms polling interval.
    const waitForSignal = (signal: Promise<void>, message: string) =>
      withTestTimeout(signal, 1_000, message);
    const preparedNames: string[] = [];
    const started: string[] = [];
    const persisted: AgentMessage[] = [];
    const make = (name: keyof typeof toolStarted, gate = Promise.resolve()) =>
      tool(name, async () => {
        started.push(name);
        toolStarted[name].resolve();
        await gate;
        return { content: [], details: {}, terminate: true };
      });
    const firstTool = make("first", firstDone.promise);
    const secondTool = make("second", secondDone.promise);
    const thirdTool = make("third");
    if (mode.endsWith("exclusive")) {
      secondTool.executionMode = "sequential";
    }
    const calls = [call("first"), call("second", mode !== "mixed-parallel"), call("third")];
    const run = runAgentLoop(
      [{ role: "user", content: "start", timestamp: 0 }],
      {
        systemPrompt: "",
        messages: [],
        tools:
          mode === "deferred-exclusive"
            ? [firstTool, thirdTool]
            : [firstTool, secondTool, thirdTool],
      },
      {
        model,
        convertToLlm: (messages) => messages as Context["messages"],
        resolveDeferredTool: ({ toolCall }) =>
          toolCall.name === "second" ? secondTool : undefined,
        beforeToolCall: async ({ toolCall }) => {
          preparedNames.push(toolCall.name);
          if (toolCall.name === "first") {
            preparing.resolve();
            await prepared.promise;
          }
          return undefined;
        },
      },
      (event) => {
        recordMessage(event, persisted);
        if (event.type === "message_end") {
          if (
            event.message.role === "assistant" &&
            persisted.filter((message) => message.role === "assistant").length ===
              (mode === "mixed-parallel" ? 2 : 3)
          ) {
            assistantFragmentsPersisted.resolve();
          }
          if (event.message.role === "toolResult" && event.message.toolCallId === "second") {
            secondResultPersisted.resolve();
          }
        }
      },
      undefined,
      () => response,
    );
    try {
      response.push({ type: "start", partial: assistant([]) });
      calls.forEach((toolCall, contentIndex) =>
        response.push({
          type: "toolcall_end",
          contentIndex,
          toolCall,
          partial: assistant(calls.slice(0, contentIndex + 1)),
        }),
      );
      if (mode === "mixed-parallel") {
        response.push({ type: "done", reason: "toolUse", message: assistant(calls, "toolUse") });
        response.end();
      }
      await preparing.promise;
      await waitForSignal(assistantFragmentsPersisted.promise, "Assistant fragments not persisted");
      expect(persisted.filter((message) => message.role === "assistant")).toHaveLength(
        mode === "mixed-parallel" ? 2 : 3,
      );
      expect(preparedNames).toEqual(["first"]);
      prepared.resolve();
      await waitForSignal(toolStarted.first.promise, "First tool did not start");
      expect(started).toContain("first");
      if (mode === "mixed-parallel") {
        await waitForSignal(toolStarted.third.promise, "Third tool did not start");
        expect(started).toEqual(["first", "second", "third"]);
        secondDone.resolve();
        await waitForSignal(secondResultPersisted.promise, "Second tool result not persisted");
        expect(
          persisted.some(
            (message) => message.role === "toolResult" && message.toolCallId === "second",
          ),
        ).toBe(true);
        expect(
          persisted.some(
            (message) => message.role === "toolResult" && message.toolCallId === "first",
          ),
        ).toBe(false);
        firstDone.resolve();
      } else {
        await setImmediate();
        expect(started).toEqual(["first"]);
        firstDone.resolve();
        await waitForSignal(toolStarted.second.promise, "Second tool did not start");
        expect(started).toEqual(["first", "second"]);
        await setImmediate();
        expect(started).not.toContain("third");
        secondDone.resolve();
        await waitForSignal(toolStarted.third.promise, "Third tool did not start");
        expect(started).toEqual(["first", "second", "third"]);
      }
    } finally {
      prepared.resolve();
      firstDone.resolve();
      secondDone.resolve();
      response.push({ type: "done", reason: "stop", message: assistant(calls) });
      response.end();
      await run;
    }
    expect(persisted.filter((message) => message.role === "toolResult")).toHaveLength(3);
  },
);

it("keeps the live assistant visible while an async tool result starts and ends", async () => {
  const response = createAssistantMessageEventStream();
  const gate = createDeferred();
  const lookupStarted = createDeferred();
  const textUpdated = createDeferred();
  const resultEnded = createDeferred();
  const source = call("lookup");
  const text = { type: "text" as const, text: "independent answer" };
  const execute = vi.fn(async () => {
    lookupStarted.resolve();
    await gate.promise;
    return { content: [{ type: "text" as const, text: "found" }], details: {} };
  });
  let requests = 0;
  const agent = new Agent({
    initialState: { model, tools: [tool("lookup", execute)] },
    streamFn: () => {
      if (++requests === 1) {
        return response;
      }
      const final = createAssistantMessageEventStream();
      final.push({
        type: "done",
        reason: "stop",
        message: assistant([{ type: "text", text: "done" }]),
      });
      final.end();
      return final;
    },
  });
  const resultStates: Array<AgentMessage | undefined> = [];
  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      textUpdated.resolve();
    }
    if (
      (event.type === "message_start" || event.type === "message_end") &&
      event.message.role === "toolResult"
    ) {
      resultStates.push(agent.state.streamingMessage);
      if (event.type === "message_end") {
        resultEnded.resolve();
      }
    }
  });
  const run = agent.prompt("look up");
  try {
    response.push({ type: "start", partial: assistant([]) });
    response.push({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: source,
      partial: assistant([source]),
    });
    await withTestTimeout(lookupStarted.promise, 1_000, "Lookup did not start");
    expect(execute).toHaveBeenCalledTimes(1);
    response.push({
      type: "text_delta",
      contentIndex: 1,
      delta: text.text,
      partial: assistant([source, text]),
    });
    await withTestTimeout(textUpdated.promise, 1_000, "Assistant text not updated");
    expect(agent.state.streamingMessage).toMatchObject({ role: "assistant", content: [text] });
    const activeAssistant = agent.state.streamingMessage;
    gate.resolve();
    await withTestTimeout(resultEnded.promise, 1_000, "Tool result did not end");
    expect(resultStates).toHaveLength(2);
    expect(resultStates).toEqual([activeAssistant, activeAssistant]);
    expect(agent.state.streamingMessage).toBe(activeAssistant);
  } finally {
    gate.resolve();
    response.push({ type: "done", reason: "stop", message: assistant([source, text]) });
    response.end();
    await run;
  }
  expect(agent.state.streamingMessage).toBeUndefined();
});

it.each(["length"] as const)(
  "persists an execution identity for a done-only async %s response",
  async (stopReason) => {
    const persisted: AgentMessage[] = [];
    const execute = vi.fn(async () => {
      const owner = getAgentToolExecutionContext()?.assistantMessage;
      expect(owner?.turnId).toBeTruthy();
      expect(persisted).toContain(owner);
      return { content: [], details: {}, terminate: true };
    });
    const response = createAssistantMessageEventStream();
    response.push({
      type: "done",
      reason: stopReason,
      message: assistant([call("lookup")], stopReason),
    });
    response.end();
    const result = await runAgentLoop(
      [{ role: "user", content: "look up", timestamp: 0 }],
      { systemPrompt: "", messages: [], tools: [tool("lookup", execute)] },
      { model, convertToLlm: (messages) => messages as Context["messages"] },
      (event) => recordMessage(event, persisted),
      undefined,
      () => response,
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual(persisted);
    expect(result.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "lookup",
      isError: false,
    });
  },
);

it("persists async calls before admission, streams the remaining answer, and executes each call once", async () => {
  const response = createAssistantMessageEventStream();
  const gate = createDeferred();
  const lookupStarted = createDeferred();
  const textUpdated = createDeferred();
  const resultPersisted = createDeferred();
  const source = call("lookup");
  const ordinary = call("ordinary", false);
  const persisted: AgentMessage[] = [];
  const events: AgentEvent[] = [];
  const executionOrder: string[] = [];
  const contexts: Context[] = [];
  const lookup = vi.fn(async () => {
    const owner = getAgentToolExecutionContext()?.assistantMessage;
    expect(persisted).toContain(owner);
    expect(owner?.turnId).toBeTruthy();
    executionOrder.push("lookup");
    lookupStarted.resolve();
    await gate.promise;
    return { content: [{ type: "text" as const, text: "lookup result" }], details: {} };
  });
  const ordinaryExecute = vi.fn(async () => {
    executionOrder.push("ordinary");
    return { content: [], details: {} };
  });
  const streamFn: StreamFn = (_model, context) => {
    contexts.push({ messages: structuredClone(context.messages) });
    if (contexts.length === 1) {
      return response;
    }
    const final = createAssistantMessageEventStream();
    final.push({
      type: "done",
      reason: "stop",
      message: assistant([{ type: "text", text: "done" }]),
    });
    final.end();
    return final;
  };
  const run = runAgentLoop(
    [{ role: "user", content: "look up", timestamp: 0 }],
    {
      systemPrompt: "",
      messages: [],
      tools: [tool("lookup", lookup), tool("ordinary", ordinaryExecute)],
    },
    {
      model,
      convertToLlm: (messages) => messages as Context["messages"],
      beforeToolBatch: async ({ calls }) =>
        attachInternalToolBatchLifecycle(
          {},
          {
            commitReadyCalls: () => executionOrder.push(`admit:${calls[0]?.toolCall.id}`),
            releaseSkippedCalls: () => {},
          },
        ),
    },
    (event) => {
      events.push(event);
      recordMessage(event, persisted);
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        textUpdated.resolve();
      }
      if (event.type === "message_end" && event.message.role === "toolResult") {
        resultPersisted.resolve();
      }
    },
    undefined,
    streamFn,
  );
  let closed = false;
  try {
    const prefix = assistant([source], "toolUse");
    response.push({ type: "start", partial: assistant([]) });
    response.push({ type: "toolcall_end", contentIndex: 0, toolCall: source, partial: prefix });
    await withTestTimeout(lookupStarted.promise, 1_000, "Lookup did not start");
    expect(lookup).toHaveBeenCalledTimes(1);
    const text = { type: "text" as const, text: "independent answer" };
    const progress = assistant([source, text]);
    response.push({ type: "text_delta", contentIndex: 1, delta: text.text, partial: progress });
    response.push({
      type: "toolcall_end",
      contentIndex: 2,
      toolCall: ordinary,
      partial: assistant([source, text, ordinary]),
    });
    await withTestTimeout(textUpdated.promise, 1_000, "Assistant text not updated");
    expect(
      events.some(
        (event) =>
          event.type === "message_update" && event.assistantMessageEvent.type === "text_delta",
      ),
    ).toBe(true);
    // Let the queued ordinary call reach the scheduler before checking it stayed deferred.
    await setImmediate();
    expect(ordinaryExecute).not.toHaveBeenCalled();
    const textEvent = events.find(
      (event) =>
        event.type === "message_update" && event.assistantMessageEvent.type === "text_delta",
    );
    expect(textEvent).toMatchObject({
      assistantMessageEvent: { contentIndex: 0 },
      message: { content: [text] },
    });
    gate.resolve();
    await withTestTimeout(resultPersisted.promise, 1_000, "Tool result not persisted");
    expect(persisted.some((message) => message.role === "toolResult")).toBe(true);
    response.push({
      type: "done",
      reason: "toolUse",
      message: assistant([source, text, ordinary], "toolUse"),
    });
    response.end();
    closed = true;
    const result = await run;
    expect(result).toEqual(persisted);
    expect(executionOrder).toEqual(["admit:lookup", "lookup", "admit:ordinary", "ordinary"]);
    expect(
      result
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.content)
        .filter((item) => item.type === "toolCall")
        .map((item) => item.id),
    ).toEqual(["lookup", "ordinary"]);
    expect(contexts[1]?.messages).toEqual(persisted.slice(0, -1));
    expect(
      persisted
        .filter((message) => message.role === "assistant")
        .map((message) => message.usage.totalTokens),
    ).toEqual([0, 9, 9]);
  } finally {
    gate.resolve();
    if (!closed) {
      response.push({ type: "done", reason: "toolUse", message: assistant([source], "toolUse") });
      response.end();
    }
    await run;
  }
});

it("preserves external cancellation when an output-limited async batch hits the critical loop limit", async () => {
  const response = createAssistantMessageEventStream();
  const beforeBatch = createDeferred();
  const releaseBatch = createDeferred();
  const controller = new AbortController();
  const execute = vi.fn(async () => ({ content: [], details: {} }));
  const loop = call("loop");
  const events: AgentEvent[] = [];
  const run = runAgentLoop(
    [{ role: "user", content: "continue", timestamp: 0 }],
    { systemPrompt: "", messages: [], tools: [tool("loop", execute)] },
    {
      model,
      convertToLlm: (messages) => messages as Context["messages"],
      toolLoopRecoveryState: { criticalToolLoopSeen: true },
      beforeToolBatch: async () => {
        beforeBatch.resolve();
        await releaseBatch.promise;
        return {
          intervention: {
            kind: "critical-tool-loop",
            toolCallId: loop.id,
            toolName: loop.name,
            actionKey: "loop:same-action",
            detector: "generic_repeat",
            count: 20,
            reason: "Repeated critical tool loop",
          },
        };
      },
    },
    (event) => {
      events.push(event);
      if (event.type === "tool_execution_end") {
        controller.abort(new Error("Operator stopped the run"));
      }
    },
    controller.signal,
    () => response,
  );
  try {
    response.push({ type: "start", partial: assistant([]) });
    response.push({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: loop,
      partial: assistant([loop]),
    });
    await beforeBatch.promise;
    response.push({
      type: "error",
      reason: "error",
      error: {
        ...assistant([loop], "error"),
        errorCode: "incomplete_tool_call",
        diagnostics: [
          {
            type: "openai_responses_terminal",
            timestamp: 1,
            details: {
              eventType: "response.incomplete",
              stopReason: "length",
              incompleteReason: "max_output_tokens",
            },
          },
        ],
      },
    });
    response.end();
    releaseBatch.resolve();
    const messages = await run;
    expect(execute).not.toHaveBeenCalled();
    expect(messages.findLast((message) => message.role === "assistant")).toMatchObject({
      stopReason: "aborted",
      usage,
    });
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
  } finally {
    releaseBatch.resolve();
    controller.abort();
    response.end();
    await run;
  }
});

it.each(["aborted", "output-limit"] as const)(
  "settles running async tools with queued source starts after %s",
  async (failureKind) => {
    const stopReason = failureKind === "aborted" ? "aborted" : "error";
    const outputLimit = failureKind === "output-limit";
    const response = createAssistantMessageEventStream();
    const gate = createDeferred();
    const persistTerminal = createDeferred();
    const firstStarted = createDeferred();
    const terminalRecorded = createDeferred();
    const resultsPersisted = createDeferred();
    const first = call("first");
    const second = call("second");
    const persisted: AgentMessage[] = [];
    const events: AgentEvent[] = [];
    const firstExecute = vi.fn<AgentTool["execute"]>(async (_id, _args, signal) => {
      firstStarted.resolve();
      await gate.promise;
      expect(signal?.aborted).toBe(!outputLimit);
      return { content: [], details: {} };
    });
    const secondExecute = vi.fn(async () => ({ content: [], details: {} }));
    const streamFn = vi.fn(() => response);
    const run = runAgentLoop(
      [{ role: "user", content: "start", timestamp: 0 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [tool("first", firstExecute), tool("second", secondExecute)],
      },
      {
        model,
        toolExecution: "sequential",
        convertToLlm: (messages) => messages as Context["messages"],
      },
      async (event) => {
        events.push(event);
        recordMessage(event, persisted);
        if (
          event.type === "message_end" &&
          event.message.role === "toolResult" &&
          persisted.filter((message) => message.role === "toolResult").length === 2
        ) {
          resultsPersisted.resolve();
        }
        if (
          event.type === "message_end" &&
          event.message.role === "assistant" &&
          event.message.stopReason === stopReason
        ) {
          terminalRecorded.resolve();
          await persistTerminal.promise;
        }
      },
      undefined,
      streamFn,
    );
    let closed = false;
    try {
      response.push({ type: "start", partial: assistant([]) });
      response.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: first,
        partial: assistant([first]),
      });
      response.push({
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: second,
        partial: assistant([first, second]),
      });
      await withTestTimeout(firstStarted.promise, 1_000, "First tool did not start");
      expect(firstExecute).toHaveBeenCalledTimes(1);
      const failure = {
        ...assistant([first, second], stopReason),
        errorMessage: "stream failed",
        ...(outputLimit
          ? {
              errorCode: "incomplete_tool_call",
              diagnostics: [
                {
                  type: "openai_responses_terminal",
                  timestamp: 1,
                  details: {
                    eventType: "response.incomplete",
                    stopReason: "length",
                    incompleteReason: "max_output_tokens",
                  },
                },
              ],
            }
          : {}),
      };
      response.push({ type: "error", reason: stopReason, error: failure });
      response.end();
      closed = true;
      if (outputLimit) {
        gate.resolve();
      }
      await withTestTimeout(terminalRecorded.promise, 1_000, "Assistant terminal not recorded");
      expect(
        persisted.some(
          (message) => message.role === "assistant" && message.stopReason === stopReason,
        ),
      ).toBe(true);
      // Give finalization a turn to expose a missing persistence await while the gate is held.
      await setImmediate();
      expect(events.at(-1)?.type).not.toBe("agent_end");
      gate.resolve();
      await withTestTimeout(resultsPersisted.promise, 1_000, "Tool results not persisted");
      expect(persisted.filter((message) => message.role === "toolResult")).toHaveLength(2);
      expect(secondExecute).toHaveBeenCalledTimes(outputLimit ? 1 : 0);
      persistTerminal.resolve();
      const result = await run;
      expect(result).toEqual(persisted);
      expect(secondExecute).toHaveBeenCalledTimes(outputLimit ? 1 : 0);
      expect(streamFn).toHaveBeenCalledTimes(1);
      expect(
        result
          .filter((message) => message.role === "toolResult")
          .map((message) => ({ id: message.toolCallId, isError: message.isError })),
      ).toEqual([
        { id: "first", isError: false },
        { id: "second", isError: !outputLimit },
      ]);
      expect(events.at(-1)?.type).toBe("agent_end");
    } finally {
      gate.resolve();
      persistTerminal.resolve();
      if (!closed) {
        const failure = {
          ...assistant([first, second], stopReason),
          errorMessage: "stream failed",
        };
        response.push({ type: "error", reason: stopReason, error: failure });
        response.end();
      }
      await run;
    }
  },
);

function yieldAssistant(
  content: AssistantMessage["content"],
  responseId: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    responseId,
    stopReason: "stop",
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: 1,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

it.each([
  { priorResult: "completed", asyncYield: true },
  { priorResult: "pending", asyncYield: true },
  { priorResult: "completed", asyncYield: false },
] as const)(
  "delivers $priorResult async output before yielding (async yield: $asyncYield)",
  async ({ priorResult, asyncYield }) => {
    const controller = new AbortController();
    const lookupStarted = createDeferred();
    const lookupRelease = createDeferred();
    const lookupPersisted = createDeferred();
    const firstYieldPersisted = createDeferred();
    const first = createAssistantMessageEventStream();
    const second = createAssistantMessageEventStream();
    const inputs: Context["messages"][] = [];
    const persisted: AgentMessage[] = [];
    const lookupCall: ToolCall = {
      type: "toolCall",
      id: "lookup",
      name: "lookup",
      arguments: {},
      async: true,
    };
    const yieldCall: ToolCall = {
      type: "toolCall",
      id: "yield-first",
      name: "sessions_yield",
      arguments: { waitFor: "message" },
      ...(asyncYield ? { async: true } : {}),
    };
    const lookup: AgentTool = {
      name: "lookup",
      label: "lookup",
      description: "lookup",
      parameters: Type.Object({}),
      execute: async () => {
        lookupStarted.resolve();
        await lookupRelease.promise;
        return { content: [{ type: "text", text: "already completed" }], details: {} };
      },
    };
    const claimYield = vi.fn(
      createRequesterYieldCallback({
        requesterAgentId: "diagnostic",
        // This loop fixture owns a runtime completion; native child admission
        // is covered at the requester boundary, not inferred from a fake key.
        claimYieldCompletion: () => true,
      }),
    );
    const onYield = vi.fn(() => {
      controller.abort(new Error("sessions_yield"));
      const active = inputs.length === 1 ? first : second;
      active.push({
        type: "error",
        reason: "aborted",
        error: {
          ...yieldAssistant([], "yielded"),
          stopReason: "aborted",
          errorMessage: "sessions_yield",
        },
      });
      active.end();
    });
    const yieldTool = createSessionsYieldTool({
      sessionId: "diagnostic-child",
      claimYield,
      onYield,
    });
    const streamFn: StreamFn = (_model, context) => {
      inputs.push(structuredClone(context.messages));
      if (inputs.length === 1) {
        return first;
      }
      const nextCall = { ...yieldCall, id: "yield-next", async: true as const };
      second.push({ type: "start", partial: yieldAssistant([], "second") });
      second.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: nextCall,
        partial: yieldAssistant([nextCall], "second"),
      });
      return second;
    };
    const run = runAgentLoop(
      [{ role: "user", content: "Inspect then wait", timestamp: 0 }],
      { systemPrompt: "", messages: [], tools: [lookup, yieldTool] },
      {
        model,
        convertToLlm: (messages) => messages as Context["messages"],
        // Mirror the production session hook that classifies structured tool errors.
        afterToolCall: async ({ result }) => ({ isError: isToolResultError(result) }),
      },
      (event) => {
        if (event.type !== "message_end") {
          return;
        }
        persisted.push(event.message);
        if (event.message.role === "toolResult") {
          if (event.message.toolCallId === "lookup") {
            lookupPersisted.resolve();
          }
          if (event.message.toolCallId === "yield-first") {
            firstYieldPersisted.resolve();
          }
        }
      },
      controller.signal,
      streamFn,
    );
    try {
      first.push({ type: "start", partial: yieldAssistant([], "first") });
      first.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: lookupCall,
        partial: yieldAssistant([lookupCall], "first"),
      });
      await lookupStarted.promise;
      if (priorResult !== "pending") {
        lookupRelease.resolve();
        await lookupPersisted.promise;
      }
      first.push({
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: yieldCall,
        partial: yieldAssistant([lookupCall, yieldCall], "first"),
      });
      if (!asyncYield) {
        first.push({
          type: "done",
          reason: "toolUse",
          message: { ...yieldAssistant([lookupCall, yieldCall], "first"), stopReason: "toolUse" },
        });
        first.end();
      }
      await firstYieldPersisted.promise;
      expect(claimYield).not.toHaveBeenCalled();
      expect(onYield).not.toHaveBeenCalled();
      expect(persisted).toContainEqual(
        expect.objectContaining({
          role: "toolResult",
          toolCallId: "yield-first",
          isError: false,
          details: expect.objectContaining({ status: "deferred" }),
        }),
      );
      if (priorResult === "pending") {
        expect(
          persisted.some(
            (message) => message.role === "toolResult" && message.toolCallId === "lookup",
          ),
        ).toBe(false);
        lookupRelease.resolve();
        await lookupPersisted.promise;
      }
      if (asyncYield) {
        first.push({
          type: "done",
          reason: "stop",
          message: yieldAssistant([lookupCall, yieldCall], "first"),
        });
        first.end();
      }
      await run;
      expect(claimYield).toHaveBeenCalledTimes(1);
      expect(onYield).toHaveBeenCalledTimes(1);
      expect(inputs).toHaveLength(2);
      expect(inputs[1]).toContainEqual(
        expect.objectContaining({
          role: "toolResult",
          toolCallId: "lookup",
          isError: false,
          content: [{ type: "text", text: "already completed" }],
        }),
      );
    } finally {
      lookupRelease.resolve();
      controller.abort();
      for (const response of [first, second]) {
        response.end({ ...yieldAssistant([], "cleanup"), stopReason: "aborted" });
      }
      await run;
    }
  },
);
