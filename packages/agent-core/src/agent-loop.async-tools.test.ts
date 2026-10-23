import { setImmediate } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import type { AssistantMessage, Context, Model, ToolCall } from "@openclaw/llm-core";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { createRequesterYieldCallback } from "../../../src/agents/openclaw-tools.requester-yield.js";
import { isToolResultError } from "../../../src/agents/tool-result-error.js";
import { createSessionsYieldTool } from "../../../src/agents/tools/sessions-yield-tool.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import {
  captureToolLoop,
  expectedToolResult,
  finishMessageStream,
  startToolCalls,
  makeAssistantMessage,
  model as baseModel,
} from "./agent-loop.test-support.js";
import { Agent } from "./agent.js";
import { attachInternalToolBatchLifecycle } from "./internal-hooks.js";
import { getAgentToolExecutionContext } from "./tool-execution-context.js";
import type { AgentEvent, AgentMessage, AgentTool, StreamFn } from "./types.js";

const model: Model = { ...baseModel, id: "async-model", name: "Async Model", reasoning: true };
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
  responseId?: string,
): AssistantMessage {
  return {
    ...makeAssistantMessage(content),
    stopReason,
    model: model.id,
    usage: responseId ? { ...usage, input: 1, output: 1, cacheRead: 0, totalTokens: 2 } : usage,
    ...(responseId ? { responseId } : {}),
  };
}
function tool(name: string, execute: AgentTool["execute"]): AgentTool {
  return { name, label: name, description: name, parameters: Type.Object({}), execute };
}
function call(id: string, async = true): ToolCall {
  return { type: "toolCall", name: id, id, arguments: {}, ...(async ? { async: true } : {}) };
}
function pushCall(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  toolCall: ToolCall,
  contentIndex: number,
  partial: AssistantMessage,
) {
  stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
}

function finish(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  message: AssistantMessage,
  reason: "stop" | "toolUse" | "length" = "stop",
) {
  finishMessageStream(stream, message, reason);
}

function fail(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  error: AssistantMessage,
  reason: "error" | "aborted" = "error",
) {
  finishMessageStream(stream, error, reason);
}

function completedResponse() {
  const stream = createAssistantMessageEventStream();
  finish(stream, assistant([{ type: "text", text: "done" }]));
  return stream;
}

const assistants = (messages: AgentMessage[]) => messages.filter((m) => m.role === "assistant");
const results = (messages: AgentMessage[]) => messages.filter((m) => m.role === "toolResult");
const resultFor = (messages: AgentMessage[], id: string) =>
  results(messages).find((m) => m.toolCallId === id);
const isTextDelta = (event: AgentEvent) =>
  event.type === "message_update" && event.assistantMessageEvent.type === "text_delta";
const wait = (signal: Promise<void>, message: string) => withTestTimeout(signal, 1_000, message);

function startCalls(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  calls: ToolCall[],
  message = assistant,
) {
  startToolCalls(stream, calls, message);
}

const runFixture = (options: Parameters<typeof captureToolLoop>[0]) =>
  captureToolLoop({ ...options, config: { model, ...options.config } });

function outputLimitFailure(content: AssistantMessage["content"]): AssistantMessage {
  return {
    ...assistant(content, "error"),
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
  };
}

it.each(["mixed-parallel", "deferred-exclusive"] as const)(
  "preserves %s scheduling for streamed async calls",
  async (mode) => {
    const parallel = mode === "mixed-parallel";
    const fragmentCount = parallel ? 2 : 3;
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
    const preparedNames: string[] = [];
    const started: string[] = [];
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
    if (!parallel) {
      secondTool.executionMode = "sequential";
    }
    const calls = [call("first"), call("second", !parallel), call("third")];
    const { response, persisted, run } = runFixture({
      tools: parallel ? [firstTool, secondTool, thirdTool] : [firstTool, thirdTool],
      config: {
        resolveDeferredTool: ({ toolCall }) =>
          toolCall.name === "second" ? secondTool : undefined,
        beforeToolCall: async ({ toolCall }) => {
          preparedNames.push(toolCall.name);
          if (toolCall.name === "first") {
            preparing.resolve();
            await prepared.promise;
          }
        },
      },
      onMessage: (message) => {
        if (message.role === "assistant" && assistants(persisted).length === fragmentCount) {
          assistantFragmentsPersisted.resolve();
        }
        if (message.role === "toolResult" && message.toolCallId === "second") {
          secondResultPersisted.resolve();
        }
      },
    });
    try {
      startCalls(response, calls);
      if (parallel) {
        finish(response, assistant(calls, "toolUse"), "toolUse");
      }
      await preparing.promise;
      await wait(assistantFragmentsPersisted.promise, "Assistant fragments not persisted");
      expect(assistants(persisted)).toHaveLength(fragmentCount);
      expect(preparedNames).toEqual(["first"]);
      prepared.resolve();
      await wait(toolStarted.first.promise, "First tool did not start");
      expect(started).toContain("first");
      if (parallel) {
        await wait(toolStarted.third.promise, "Third tool did not start");
        expect(started).toEqual(["first", "second", "third"]);
        secondDone.resolve();
        await wait(secondResultPersisted.promise, "Second tool result not persisted");
        expect(resultFor(persisted, "second")).toBeDefined();
        expect(resultFor(persisted, "first")).toBeUndefined();
        firstDone.resolve();
      } else {
        await setImmediate();
        expect(started).toEqual(["first"]);
        firstDone.resolve();
        await wait(toolStarted.second.promise, "Second tool did not start");
        expect(started).toEqual(["first", "second"]);
        await setImmediate();
        expect(started).not.toContain("third");
        secondDone.resolve();
        await wait(toolStarted.third.promise, "Third tool did not start");
        expect(started).toEqual(["first", "second", "third"]);
      }
    } finally {
      prepared.resolve();
      firstDone.resolve();
      secondDone.resolve();
      finish(response, assistant(calls));
      await run;
    }
    expect(results(persisted)).toHaveLength(3);
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
      return ++requests === 1 ? response : completedResponse();
    },
  });
  const resultStates: Array<AgentMessage | undefined> = [];
  agent.subscribe((event) => {
    if (isTextDelta(event)) {
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
    startCalls(response, [source]);
    await wait(lookupStarted.promise, "Lookup did not start");
    expect(execute).toHaveBeenCalledTimes(1);
    response.push({
      type: "text_delta",
      contentIndex: 1,
      delta: text.text,
      partial: assistant([source, text]),
    });
    await wait(textUpdated.promise, "Assistant text not updated");
    expect(agent.state.streamingMessage).toMatchObject({ role: "assistant", content: [text] });
    const activeAssistant = agent.state.streamingMessage;
    gate.resolve();
    await wait(resultEnded.promise, "Tool result did not end");
    expect(resultStates).toEqual([activeAssistant, activeAssistant]);
    expect(agent.state.streamingMessage).toBe(activeAssistant);
  } finally {
    gate.resolve();
    finish(response, assistant([source, text]));
    await run;
  }
  expect(agent.state.streamingMessage).toBeUndefined();
});

it("persists an execution identity for a done-only async length response", async () => {
  const execute = vi.fn(async () => {
    const owner = getAgentToolExecutionContext()?.assistantMessage;
    expect(owner?.turnId).toBeTruthy();
    expect(persisted).toContain(owner);
    return { content: [], details: {}, terminate: true };
  });
  const { response, persisted, run } = runFixture({ tools: [tool("lookup", execute)] });
  finish(response, assistant([call("lookup")], "length"), "length");
  const result = await run;
  expect(execute).toHaveBeenCalledTimes(1);
  expect(result).toEqual(persisted);
  expect(result.at(-1)).toMatchObject(expectedToolResult("lookup", false));
});

it("persists async calls before admission, streams the remaining answer, and executes each call once", async () => {
  const gate = createDeferred();
  const lookupStarted = createDeferred();
  const textUpdated = createDeferred();
  const resultPersisted = createDeferred();
  const source = call("lookup");
  const ordinary = call("ordinary", false);
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
    return contexts.length === 1 ? response : completedResponse();
  };
  const { response, persisted, events, run } = runFixture({
    tools: [tool("lookup", lookup), tool("ordinary", ordinaryExecute)],
    config: {
      beforeToolBatch: async ({ calls }) =>
        attachInternalToolBatchLifecycle(
          {},
          {
            commitReadyCalls: () => executionOrder.push(`admit:${calls[0]?.toolCall.id}`),
            releaseSkippedCalls: () => {},
          },
        ),
    },
    onEvent: (event) => {
      if (isTextDelta(event)) {
        textUpdated.resolve();
      }
      if (event.type === "message_end" && event.message.role === "toolResult") {
        resultPersisted.resolve();
      }
    },
    streamFn,
  });
  let closed = false;
  try {
    startCalls(response, [source], (content) =>
      assistant(content, content.length ? "toolUse" : "stop"),
    );
    await wait(lookupStarted.promise, "Lookup did not start");
    expect(lookup).toHaveBeenCalledTimes(1);
    const text = { type: "text" as const, text: "independent answer" };
    response.push({
      type: "text_delta",
      contentIndex: 1,
      delta: text.text,
      partial: assistant([source, text]),
    });
    pushCall(response, ordinary, 2, assistant([source, text, ordinary]));
    await wait(textUpdated.promise, "Assistant text not updated");
    // Let the queued ordinary call reach the scheduler before checking it stayed deferred.
    await setImmediate();
    expect(ordinaryExecute).not.toHaveBeenCalled();
    expect(events.find(isTextDelta)).toMatchObject({
      assistantMessageEvent: { contentIndex: 0 },
      message: { content: [text] },
    });
    gate.resolve();
    await wait(resultPersisted.promise, "Tool result not persisted");
    expect(results(persisted).length).toBeGreaterThan(0);
    finish(response, assistant([source, text, ordinary], "toolUse"), "toolUse");
    closed = true;
    const result = await run;
    expect(result).toEqual(persisted);
    expect(executionOrder).toEqual(["admit:lookup", "lookup", "admit:ordinary", "ordinary"]);
    expect(
      assistants(result)
        .flatMap((message) => message.content)
        .filter((item) => item.type === "toolCall")
        .map((item) => item.id),
    ).toEqual(["lookup", "ordinary"]);
    expect(contexts[1]?.messages).toEqual(persisted.slice(0, -1));
    expect(assistants(persisted).map((message) => message.usage.totalTokens)).toEqual([0, 9, 9]);
  } finally {
    gate.resolve();
    if (!closed) {
      finish(response, assistant([source], "toolUse"), "toolUse");
    }
    await run;
  }
});

it("preserves external cancellation when an output-limited async batch hits the critical loop limit", async () => {
  const beforeBatch = createDeferred();
  const releaseBatch = createDeferred();
  const controller = new AbortController();
  const execute = vi.fn(async () => ({ content: [], details: {} }));
  const loop = call("loop");
  const { response, events, run } = runFixture({
    tools: [tool("loop", execute)],
    config: {
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
    onEvent: (event) => {
      if (event.type === "tool_execution_end") {
        controller.abort(new Error("Operator stopped the run"));
      }
    },
    signal: controller.signal,
  });
  try {
    startCalls(response, [loop]);
    await beforeBatch.promise;
    fail(response, outputLimitFailure([loop]));
    releaseBatch.resolve();
    const messages = await run;
    expect(execute).not.toHaveBeenCalled();
    expect(assistants(messages).at(-1)).toMatchObject({ stopReason: "aborted", usage });
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
    const gate = createDeferred();
    const persistTerminal = createDeferred();
    const firstStarted = createDeferred();
    const terminalRecorded = createDeferred();
    const resultsPersisted = createDeferred();
    const first = call("first");
    const second = call("second");
    const firstExecute = vi.fn<AgentTool["execute"]>(async (_id, _args, signal) => {
      firstStarted.resolve();
      await gate.promise;
      expect(signal?.aborted).toBe(!outputLimit);
      return { content: [], details: {} };
    });
    const secondExecute = vi.fn(async () => ({ content: [], details: {} }));
    const streamFn = vi.fn(() => response);
    const { response, persisted, events, run } = runFixture({
      tools: [tool("first", firstExecute), tool("second", secondExecute)],
      config: { toolExecution: "sequential" },
      onMessage: async (message) => {
        if (message.role === "toolResult" && results(persisted).length === 2) {
          resultsPersisted.resolve();
        }
        if (message.role === "assistant" && message.stopReason === stopReason) {
          terminalRecorded.resolve();
          await persistTerminal.promise;
        }
      },
      streamFn,
    });
    let closed = false;
    try {
      startCalls(response, [first, second]);
      await wait(firstStarted.promise, "First tool did not start");
      expect(firstExecute).toHaveBeenCalledTimes(1);
      const failure = {
        ...(outputLimit
          ? outputLimitFailure([first, second])
          : assistant([first, second], stopReason)),
        errorMessage: "stream failed",
      };
      fail(response, failure, stopReason);
      closed = true;
      if (outputLimit) {
        gate.resolve();
      }
      await wait(terminalRecorded.promise, "Assistant terminal not recorded");
      expect(assistants(persisted).some((m) => m.stopReason === stopReason)).toBe(true);
      // Give finalization a turn to expose a missing persistence await while the gate is held.
      await setImmediate();
      expect(events.at(-1)?.type).not.toBe("agent_end");
      gate.resolve();
      await wait(resultsPersisted.promise, "Tool results not persisted");
      expect(results(persisted)).toHaveLength(2);
      expect(secondExecute).toHaveBeenCalledTimes(outputLimit ? 1 : 0);
      persistTerminal.resolve();
      const result = await run;
      expect(result).toEqual(persisted);
      expect(secondExecute).toHaveBeenCalledTimes(outputLimit ? 1 : 0);
      expect(streamFn).toHaveBeenCalledTimes(1);
      expect(results(result)).toMatchObject([
        { toolCallId: "first", isError: false },
        { toolCallId: "second", isError: !outputLimit },
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
        fail(response, failure, stopReason);
      }
      await run;
    }
  },
);

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
    const lookupCall = call("lookup");
    const yieldCall: ToolCall = {
      ...call("yield-first", asyncYield),
      name: "sessions_yield",
      arguments: { waitFor: "message" },
    };
    const lookup = tool("lookup", async () => {
      lookupStarted.resolve();
      await lookupRelease.promise;
      return { content: [{ type: "text", text: "already completed" }], details: {} };
    });
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
      fail(
        inputs.length === 1 ? first : second,
        {
          ...assistant([], "aborted", "yielded"),
          errorMessage: "sessions_yield",
        },
        "aborted",
      );
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
      startCalls(second, [nextCall], (content) => assistant(content, "stop", "second"));
      return second;
    };
    const { persisted, run } = runFixture({
      tools: [lookup, yieldTool],
      config: {
        // Mirror the production session hook that classifies structured tool errors.
        afterToolCall: async ({ result }) => ({ isError: isToolResultError(result) }),
      },
      onMessage: (message) => {
        if (message.role !== "toolResult") {
          return;
        }
        if (message.toolCallId === "lookup") {
          lookupPersisted.resolve();
        }
        if (message.toolCallId === "yield-first") {
          firstYieldPersisted.resolve();
        }
      },
      signal: controller.signal,
      streamFn,
    });
    try {
      startCalls(first, [lookupCall], (content) => assistant(content, "stop", "first"));
      await lookupStarted.promise;
      if (priorResult !== "pending") {
        lookupRelease.resolve();
        await lookupPersisted.promise;
      }
      pushCall(first, yieldCall, 1, assistant([lookupCall, yieldCall], "stop", "first"));
      if (!asyncYield) {
        finish(first, assistant([lookupCall, yieldCall], "toolUse", "first"), "toolUse");
      }
      await firstYieldPersisted.promise;
      expect(claimYield).not.toHaveBeenCalled();
      expect(onYield).not.toHaveBeenCalled();
      expect(resultFor(persisted, "yield-first")).toMatchObject({
        isError: false,
        details: { status: "deferred" },
      });
      if (priorResult === "pending") {
        expect(resultFor(persisted, "lookup")).toBeUndefined();
        lookupRelease.resolve();
        await lookupPersisted.promise;
      }
      if (asyncYield) {
        finish(first, assistant([lookupCall, yieldCall], "stop", "first"));
      }
      await run;
      expect(claimYield).toHaveBeenCalledTimes(1);
      expect(onYield).toHaveBeenCalledTimes(1);
      expect(inputs).toHaveLength(2);
      const nextInput = inputs[1];
      if (!nextInput) {
        throw new Error("Expected a second model request");
      }
      expect(resultFor(nextInput, "lookup")).toMatchObject({
        isError: false,
        content: [{ type: "text", text: "already completed" }],
      });
    } finally {
      lookupRelease.resolve();
      controller.abort();
      for (const response of [first, second]) {
        response.end(assistant([], "aborted", "cleanup"));
      }
      await run;
    }
  },
);
