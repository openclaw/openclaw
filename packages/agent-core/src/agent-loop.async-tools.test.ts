import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
  ToolCall,
} from "@openclaw/llm-core";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createRequesterYieldCallback } from "../../../src/agents/openclaw-tools.requester-yield.js";
import { isToolResultError } from "../../../src/agents/tool-result-error.js";
import { createSessionsYieldTool } from "../../../src/agents/tools/sessions-yield-tool.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { streamOpenAICodexResponses } from "../../ai/src/providers/openai-chatgpt-responses.js";
import {
  closeServer,
  completedResponse as completedWireResponse,
  createLoopbackModel,
  createJwt,
} from "../../ai/src/providers/openai-chatgpt-responses.test-helpers.js";
import { wireCall, wireMessage } from "../../ai/src/transports/openai-stream-cases.test-support.js";
import { runAgentLoop } from "./agent-loop.js";
import * as fixtures from "./agent-loop.test-support.js";
import { streamAgentResponse } from "./agent-stream-response.js";
import { Agent } from "./agent.js";
import { attachInternalToolBatchLifecycle, setInternalBeforeToolBatch } from "./internal-hooks.js";
import { distinctRecordOutputs, variedRows } from "./repetition-guard.test-fixtures.js";
import { getAgentToolExecutionContext } from "./tool-execution-context.js";
import type { AgentEvent, AgentMessage, AgentTool, AgentToolCall, StreamFn } from "./types.js";

const model: Model = { ...fixtures.model, id: "async-model", name: "Async Model", reasoning: true };
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
    ...fixtures.makeAssistantMessage(content),
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

function textDelta(
  contentIndex: number,
  delta: string,
  partial?: AssistantMessage,
): AssistantMessageEvent {
  return { type: "text_delta", contentIndex, delta, ...(partial ? { partial } : {}) };
}

function completedResponse() {
  const stream = createAssistantMessageEventStream();
  fixtures.finishMessageStream(stream, assistant([{ type: "text", text: "done" }]));
  return stream;
}

const assistants = (messages: AgentMessage[]) => messages.filter((m) => m.role === "assistant");
const results = (messages: AgentMessage[]) => messages.filter((m) => m.role === "toolResult");
const resultFor = (messages: AgentMessage[], id: string) =>
  results(messages).find((m) => m.toolCallId === id);
const isTextDelta = (event: AgentEvent) =>
  event.type === "message_update" && event.assistantMessageEvent.type === "text_delta";
const wait = (signal: Promise<void>) =>
  withTestTimeout(signal, 1_000, "Agent event did not arrive");

function startCalls(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  calls: ToolCall[],
  message = assistant,
) {
  fixtures.startToolCalls(stream, calls, message);
}

const runFixture = (options: Parameters<typeof fixtures.captureToolLoop>[0]) =>
  fixtures.captureToolLoop({ ...options, config: { model, ...options.config } });

function cleanup(
  run: Promise<unknown>,
  streams: ReturnType<typeof createAssistantMessageEventStream>[],
  ...release: (() => void)[]
) {
  onTestFinished(async () => {
    release.forEach((resolve) => resolve());
    streams.forEach((stream) => stream.end(assistant([], "aborted")));
    await run;
  });
}

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
    const { response, persisted, run, waitForMessage } = runFixture({
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
    });
    cleanup(run, [response], prepared.resolve, firstDone.resolve, secondDone.resolve);
    startCalls(response, calls);
    if (parallel) {
      fixtures.finishMessageStream(response, assistant(calls, "toolUse"), "toolUse");
    }
    await preparing.promise;
    await wait(waitForMessage(() => assistants(persisted).length === fragmentCount));
    expect(assistants(persisted)).toHaveLength(fragmentCount);
    expect(preparedNames).toEqual(["first"]);
    prepared.resolve();
    await wait(toolStarted.first.promise);
    if (parallel) {
      await wait(toolStarted.third.promise);
      expect(started).toEqual(["first", "second", "third"]);
      secondDone.resolve();
      await wait(waitForMessage(() => resultFor(persisted, "second") !== undefined));
      expect(resultFor(persisted, "first")).toBeUndefined();
      firstDone.resolve();
    } else {
      await setImmediate();
      expect(started).toEqual(["first"]);
      firstDone.resolve();
      await wait(toolStarted.second.promise);
      expect(started).toEqual(["first", "second"]);
      await setImmediate();
      expect(started).not.toContain("third");
      secondDone.resolve();
      await wait(toolStarted.third.promise);
      expect(started).toEqual(["first", "second", "third"]);
    }
    fixtures.finishMessageStream(response, assistant(calls));
    await run;
    expect(results(persisted)).toHaveLength(3);
  },
);

it("forwards unchanged updates without copying events or inspecting prior content", async () => {
  const message = fixtures.makeAssistantMessage([
    { type: "thinking", thinking: "synthetic thought" },
    { type: "text", text: "answer" },
    fixtures.makeCall("lookup"),
  ]);
  message.stopReason = "stop";
  let blockReads = 0;
  message.content = new Proxy(message.content, {
    get(target, key, receiver) {
      if (key === "0") {
        blockReads++;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const updates: AssistantMessageEvent[] = [
    { type: "thinking_start", contentIndex: 0, partial: message },
    { type: "thinking_delta", contentIndex: 0, delta: "synthetic thought", partial: message },
    { type: "thinking_end", contentIndex: 0, content: "synthetic thought", partial: message },
    { type: "text_start", contentIndex: 1, partial: message },
    { type: "text_delta", contentIndex: 1, delta: "answer", partial: message },
    { type: "text_end", contentIndex: 1, content: "answer", partial: message },
    { type: "toolcall_start", contentIndex: 2, partial: message },
    { type: "toolcall_delta", contentIndex: 2, delta: "{}", partial: message },
  ];
  const readsAtUpdate: number[] = [];
  await runAgentLoop(
    [fixtures.user("hello")],
    { systemPrompt: "", messages: [] },
    fixtures.config,
    (event) => {
      if (event.type === "message_start" && event.message.role === "assistant") {
        blockReads = 0;
      }
      if (event.type === "message_update") {
        expect(event.assistantMessageEvent).toBe(updates[readsAtUpdate.length]);
        readsAtUpdate.push(blockReads);
        expect(event.message).not.toBe(message);
      }
    },
    undefined,
    () => fixtures.reply(message, [{ type: "start", partial: message }, ...updates]),
  );
  expect(readsAtUpdate).toEqual(updates.map(() => 0));
});

it("does not commit an async fragment when a listener changes an ordinary update type", async () => {
  const message = fixtures.makeAssistantMessage([{ type: "text", text: "answer" }]);
  const events: AgentEvent[] = [];
  await runAgentLoop(
    [fixtures.user("hello")],
    { systemPrompt: "", messages: [] },
    fixtures.config,
    (event) => {
      events.push(event);
      if (event.type === "message_update") {
        Object.assign(event.assistantMessageEvent, {
          type: "toolcall_end",
          toolCall: { ...fixtures.makeCall("lookup"), async: true },
        });
      }
    },
    undefined,
    () =>
      fixtures.reply(message, [
        { type: "start", partial: message },
        { type: "text_delta", contentIndex: 0, delta: "answer", partial: message },
      ]),
  );
  expect(
    events.filter((event) => event.type === "message_end" && event.message.role === "assistant"),
  ).toEqual([{ type: "message_end", message }]);
  expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
});

it("transfers the detached async prefix directly to persistence preparation", async () => {
  const lookup = call("lookup");
  const source = assistant([lookup], "stop", "response-lookup");
  const clone = globalThis.structuredClone;
  const detached: unknown[] = [];
  const cloneSpy = vi.spyOn(globalThis, "structuredClone").mockImplementation((value) => {
    const result = clone(value);
    detached.push(result);
    return result;
  });
  onTestFinished(() => cloneSpy.mockRestore());
  const prepared: AssistantMessage[] = [];
  const emitted: AgentEvent[] = [];
  const executed: AssistantMessage[] = [];
  await streamAgentResponse(
    { systemPrompt: "", messages: [] },
    fixtures.config,
    undefined,
    (event) => void emitted.push(event),
    [],
    async (message) => {
      executed.push(message);
      expect(emitted).toContainEqual({ type: "message_end", message });
      return {
        messages: [],
        terminalToolCallIds: [],
        steeringMessages: [],
        terminate: false,
        terminateRun: false,
      };
    },
    (message) => {
      prepared.push(message);
      if (message.stopReason === "toolUse") {
        Object.freeze(message.content[0]);
        Object.freeze(message.content);
        Object.freeze(message);
      }
      return message;
    },
    () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "start", partial: source } as const;
        yield { type: "toolcall_end", contentIndex: 0, toolCall: lookup, partial: source } as const;
        source.content.push({ type: "text", text: "after lookup" });
        yield {
          type: "text_delta",
          contentIndex: 1,
          delta: "after lookup",
          partial: source,
        } as const;
        yield { type: "done", reason: "stop", message: source } as const;
      },
      result: async () => source,
    }),
  );
  expect(detached).toHaveLength(1);
  expect(prepared[0]).toBe(detached[0]);
  expect(executed).toEqual([prepared[0]]);
  expect(prepared[0]).toEqual({
    ...assistant([call("lookup")], "toolUse", "response-lookup"),
    usage: fixtures.TEST_USAGE,
  });
  expect(prepared[1]?.content).toEqual([{ type: "text", text: "after lookup" }]);
  expect(source.content).toHaveLength(2);
});

it("persists an execution identity for a done-only async length response", async () => {
  const execute = vi.fn(async () => {
    const owner = getAgentToolExecutionContext()?.assistantMessage;
    expect(owner?.turnId).toBeTruthy();
    expect(persisted).toContain(owner);
    return { content: [], details: {}, terminate: true };
  });
  const { response, persisted, run } = runFixture({ tools: [tool("lookup", execute)] });
  fixtures.finishMessageStream(response, assistant([call("lookup")], "length"), "length");
  const result = await run;
  expect(result.at(-1)).toMatchObject(fixtures.expectedToolResult("lookup", false));
});

it("persists async calls before admission and keeps the live answer visible through tool completion", async () => {
  const gate = createDeferred();
  const lookupStarted = createDeferred();
  const textUpdated = createDeferred();
  const resultPersisted = createDeferred();
  const source = call("lookup");
  const ordinary = call("ordinary", false);
  const executionOrder: string[] = [];
  const contexts: Context[] = [];
  const response = createAssistantMessageEventStream();
  const events: AgentEvent[] = [];
  const resultStates: Array<AgentMessage | undefined> = [];
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
  const agent = new Agent({
    initialState: { model, tools: [tool("lookup", lookup), tool("ordinary", ordinaryExecute)] },
    streamFn,
  });
  const persisted = agent.state.messages;
  setInternalBeforeToolBatch(agent, async ({ calls }) =>
    attachInternalToolBatchLifecycle(
      {},
      {
        commitReadyCalls: () => executionOrder.push(`admit:${calls[0]?.toolCall.id}`),
        releaseSkippedCalls: () => {},
      },
    ),
  );
  agent.subscribe((event) => {
    events.push(event);
    if (isTextDelta(event)) {
      textUpdated.resolve();
    }
    if (
      (event.type === "message_start" || event.type === "message_end") &&
      event.message.role === "toolResult"
    ) {
      resultStates.push(agent.state.streamingMessage);
      if (event.type === "message_end") {
        resultPersisted.resolve();
      }
    }
  });
  const run = agent.prompt("look up");
  cleanup(run, [response], gate.resolve);
  startCalls(response, [source], (content) =>
    assistant(content, content.length ? "toolUse" : "stop"),
  );
  await wait(lookupStarted.promise);
  const text = { type: "text" as const, text: "independent answer" };
  response.push(textDelta(1, text.text, assistant([source, text])));
  await wait(textUpdated.promise);
  expect(agent.state.streamingMessage).toMatchObject({ role: "assistant", content: [text] });
  pushCall(response, ordinary, 2, assistant([source, text, ordinary]));
  // Let the queued ordinary call reach the scheduler before checking it stayed deferred.
  await setImmediate();
  expect(ordinaryExecute).not.toHaveBeenCalled();
  expect(events.find(isTextDelta)).toMatchObject({
    assistantMessageEvent: { contentIndex: 0 },
    message: { content: [text] },
  });
  const activeAssistant = agent.state.streamingMessage;
  gate.resolve();
  await wait(resultPersisted.promise);
  expect(resultStates).toEqual([activeAssistant, activeAssistant]);
  expect(agent.state.streamingMessage).toBe(activeAssistant);
  fixtures.finishMessageStream(response, assistant([source, text, ordinary], "toolUse"), "toolUse");
  await run;
  const result = agent.state.messages;
  expect(executionOrder).toEqual(["admit:lookup", "lookup", "admit:ordinary", "ordinary"]);
  expect(
    assistants(result)
      .flatMap((message) => message.content)
      .filter((item) => item.type === "toolCall")
      .map((item) => item.id),
  ).toEqual(["lookup", "ordinary"]);
  expect(contexts[1]?.messages).toEqual(persisted.slice(0, -1));
  expect(assistants(persisted).map((message) => message.usage.totalTokens)).toEqual([0, 9, 9]);
  expect(agent.state.streamingMessage).toBeUndefined();
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
  cleanup(run, [response], releaseBatch.resolve, () => controller.abort());
  startCalls(response, [loop]);
  await beforeBatch.promise;
  fixtures.finishMessageStream(response, outputLimitFailure([loop]));
  releaseBatch.resolve();
  const messages = await run;
  expect(execute).not.toHaveBeenCalled();
  expect(assistants(messages).at(-1)).toMatchObject({ stopReason: "aborted", usage });
  expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
});

it.each(["aborted", "output-limit"] as const)(
  "settles running async tools with queued source starts after %s",
  async (failureKind) => {
    const stopReason = failureKind === "aborted" ? "aborted" : "error";
    const outputLimit = failureKind === "output-limit";
    const gate = createDeferred();
    const persistTerminal = createDeferred();
    const firstStarted = createDeferred();
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
    const { response, persisted, events, run, waitForMessage } = runFixture({
      tools: [tool("first", firstExecute), tool("second", secondExecute)],
      config: { toolExecution: "sequential" },
      onMessage: (message) =>
        message.role === "assistant" && message.stopReason === stopReason
          ? persistTerminal.promise
          : undefined,
      streamFn,
    });
    cleanup(run, [response], gate.resolve, persistTerminal.resolve);
    startCalls(response, [first, second]);
    await wait(firstStarted.promise);
    const failure = {
      ...(outputLimit
        ? outputLimitFailure([first, second])
        : assistant([first, second], stopReason)),
      errorMessage: "stream failed",
    };
    fixtures.finishMessageStream(response, failure, stopReason);
    if (outputLimit) {
      gate.resolve();
    }
    await wait(waitForMessage((m) => m.role === "assistant" && m.stopReason === stopReason));
    // Give finalization a turn to expose a missing persistence await while the gate is held.
    await setImmediate();
    expect(events.at(-1)?.type).not.toBe("agent_end");
    gate.resolve();
    await wait(waitForMessage(() => results(persisted).length === 2));
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
      fixtures.finishMessageStream(
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
    const { persisted, run, waitForMessage } = runFixture({
      tools: [lookup, yieldTool],
      config: {
        // Mirror the production session hook that classifies structured tool errors.
        afterToolCall: async ({ result }) => ({ isError: isToolResultError(result) }),
      },
      signal: controller.signal,
      streamFn,
    });
    cleanup(run, [first, second], lookupRelease.resolve, () => controller.abort());
    startCalls(first, [lookupCall], (content) => assistant(content, "stop", "first"));
    await lookupStarted.promise;
    if (priorResult !== "pending") {
      lookupRelease.resolve();
      await waitForMessage(() => resultFor(persisted, "lookup") !== undefined);
    }
    pushCall(first, yieldCall, 1, assistant([lookupCall, yieldCall], "stop", "first"));
    if (!asyncYield) {
      fixtures.finishMessageStream(
        first,
        assistant([lookupCall, yieldCall], "toolUse", "first"),
        "toolUse",
      );
    }
    await waitForMessage(() => resultFor(persisted, "yield-first") !== undefined);
    expect(claimYield).not.toHaveBeenCalled();
    expect(onYield).not.toHaveBeenCalled();
    expect(resultFor(persisted, "yield-first")).toMatchObject({
      isError: false,
      details: { status: "deferred" },
    });
    if (priorResult === "pending") {
      expect(resultFor(persisted, "lookup")).toBeUndefined();
      lookupRelease.resolve();
      await waitForMessage(() => resultFor(persisted, "lookup") !== undefined);
    }
    if (asyncYield) {
      fixtures.finishMessageStream(first, assistant([lookupCall, yieldCall], "stop", "first"));
    }
    await run;
    expect(claimYield).toHaveBeenCalledTimes(1);
    expect(onYield).toHaveBeenCalledTimes(1);
    expect(inputs).toHaveLength(2);
    expect(resultFor(inputs[1] ?? [], "lookup")).toMatchObject({
      isError: false,
      content: [{ type: "text", text: "already completed" }],
    });
  },
);

describe("repetition stop at the stream owner", () => {
  const loop = "Please provide more input. ".repeat(800);
  const marker = "[Repetitive output stopped]";

  function expectResponse(
    { result, events, requests }: Awaited<ReturnType<typeof runResponse>>,
    content: AssistantMessage["content"],
    stopped = false,
  ) {
    expect(requests).toBe(1);
    const expected = {
      stopReason: stopped ? "error" : "stop",
      content,
      ...(stopped ? { errorCode: "openclaw_repetitive_output", providerReplay: undefined } : {}),
    };
    expect(result.at(-1)).toMatchObject(expected);
    expect(events.findLast((event) => event.type === "message_end")).toMatchObject({
      message: expected,
    });
  }

  async function runResponse(content: AssistantMessage["content"], enabled = true, mode = "text") {
    const terminalOnly = mode === "terminal" || mode === "replaced terminal";
    const initialText = mode.startsWith("replaced")
      ? variedRows.slice(0, loop.length + 1)
      : undefined;
    let requests = 0;
    const streamFn: StreamFn = () => {
      requests += 1;
      const events: AssistantMessageEvent[] = [];
      const message = fixtures.makeAssistantMessage(content);
      message.providerReplay = {
        v: 1,
        type: "test-checkpoint",
        data: "opaque state containing discarded output",
        api: message.api,
        provider: message.provider,
        model: message.model,
      };
      if (!terminalOnly || initialText !== undefined) {
        events.push({ type: "start", partial: fixtures.makeAssistantMessage([]) });
      }
      if (initialText !== undefined) {
        events.push(
          textDelta(
            0,
            initialText,
            fixtures.makeAssistantMessage([{ type: "text", text: initialText }]),
          ),
        );
      }
      for (const [contentIndex, block] of (terminalOnly ? [] : content).entries()) {
        const snapshot = { contentIndex, partial: message };
        if (block.type === "text" && mode === "incremental text") {
          for (let offset = 0; offset < block.text.length; offset += 1024) {
            events.push(textDelta(contentIndex, block.text.slice(offset, offset + 1024)));
          }
        } else if (block.type === "text") {
          events.push({ type: "text_delta", ...snapshot, delta: block.text });
        } else if (block.type === "thinking") {
          events.push({ type: "thinking_delta", ...snapshot, delta: block.thinking });
        }
      }
      return fixtures.reply(message, events);
    };
    const { run, events } = fixtures.captureToolLoop({
      prompt: fixtures.user(),
      tools: [],
      config: { repetitionGuard: () => enabled },
      streamFn,
    });
    return { result: await run, events, requests };
  }

  it.each(distinctRecordOutputs)("delivers $name without truncation", async ({ text }) => {
    const content: AssistantMessage["content"] = [{ type: "text", text }];
    expectResponse(await runResponse(content), content);
  });

  it.each([
    "text",
    "incremental text",
    "thinking",
    "terminal",
    "replaced terminal",
    "replaced stream",
  ])("quarantines a repetitive %s block before persistence and replay", async (kind) => {
    const prefix: AssistantMessage["content"] = kind.startsWith("replaced")
      ? []
      : [{ type: "text", text: "Earlier answer stays intact." }];
    const content: AssistantMessage["content"] = [
      ...prefix,
      kind === "thinking" ? { type: "thinking", thinking: loop } : { type: "text", text: loop },
    ];
    const response = await runResponse(content, true, kind);
    const expected: AssistantMessage["content"] = [...prefix, { type: "text", text: marker }];
    expectResponse(response, expected, true);
    if (kind.startsWith("replaced")) {
      return;
    }
    const replay: Message[][] = [];
    await runAgentLoop(
      [fixtures.user("try a shorter request")],
      { systemPrompt: "", messages: response.result, tools: [] },
      fixtures.config,
      () => {},
      undefined,
      fixtures.createTurnSequenceStream([[{ type: "text", text: "Recovered." }]], replay),
    );
    expect(JSON.stringify(replay)).not.toContain("Please provide more input.");
    expect(JSON.stringify(replay)).toContain(marker);
  });

  it("leaves the same response untouched when the policy is off", async () => {
    const content: AssistantMessage["content"] = [{ type: "text", text: loop }];
    expectResponse(await runResponse(content, false), content);
  });

  it.each(["unadmitted snapshot", "delta", "error snapshot"])(
    "quarantines a repetitive %s without admitting new tools, aborting admitted work, or retrying",
    async (source) => {
      const admitted = source !== "unadmitted snapshot";
      const response = createAssistantMessageEventStream();
      const started = createDeferred();
      const settledTool = createDeferred();
      const observed = { requests: 0, toolAborted: false };
      let requestSignal: AbortSignal | undefined;
      const executed: string[] = [];
      const kept: AgentToolCall = { ...fixtures.makeCall("kept"), async: true };
      const discarded = fixtures.makeCall("discarded");
      const streamFn: StreamFn = (_model, _context, options) => {
        if (++observed.requests > 1) {
          return fixtures.reply(
            fixtures.makeAssistantMessage([{ type: "text", text: "Unexpected retry." }]),
          );
        }
        requestSignal = options?.signal;
        requestSignal?.addEventListener("abort", () => settledTool.resolve(), { once: true });
        return response;
      };
      const { run } = fixtures.captureToolLoop({
        prompt: fixtures.user(),
        tools: [
          {
            ...fixtures.makeTool("kept"),
            execute: async (_id, _args, signal) => {
              executed.push("kept");
              started.resolve();
              await settledTool.promise;
              observed.toolAborted = signal?.aborted ?? false;
              return { content: [{ type: "text", text: "Saved." }], details: {} };
            },
          },
          fixtures.makeTool("discarded", executed),
        ],
        config: { repetitionGuard: () => true },
        onEvent: (event) => {
          if (
            event.type === "message_end" &&
            event.message.role === "assistant" &&
            event.message.content.some((item) => item.type === "text")
          ) {
            settledTool.resolve();
          }
        },
        streamFn,
      });
      const text = { type: "text" as const, text: loop };
      const bad = fixtures.makeAssistantMessage(admitted ? [kept, text, discarded] : [text, kept]);
      if (admitted) {
        fixtures.startToolCalls(response, [kept]);
        await started.promise;
      } else {
        response.push({ type: "start", partial: fixtures.makeAssistantMessage([]) });
      }
      if (source === "error snapshot") {
        response.push({ type: "error", reason: "error", error: { ...bad, stopReason: "error" } });
      } else {
        response.push(
          source === "delta"
            ? { type: "text_delta", contentIndex: 1, delta: loop, partial: bad }
            : { type: "toolcall_end", contentIndex: 1, toolCall: kept, partial: bad },
        );
        response.push({ type: "done", reason: "toolUse", message: bad });
      }
      response.end();
      const result = await run;
      expect(observed).toEqual({ requests: 1, toolAborted: false });
      expect(requestSignal?.aborted).toBe(true);
      expect(executed).toEqual(admitted ? ["kept"] : []);
      expect(result.filter((message) => message.role === "toolResult")).toMatchObject(
        admitted ? [{ toolCallId: "kept", content: [{ type: "text", text: "Saved." }] }] : [],
      );
      expect(result.filter((message) => message.role === "assistant")).toMatchObject([
        ...(admitted ? [{ content: [kept], stopReason: "toolUse" }] : []),
        { content: [{ type: "text", text: marker }], stopReason: "error" },
      ]);
      expect(JSON.stringify(result)).not.toContain("Please provide more input.");
    },
  );
});

describe("Responses continuation", () => {
  const textItem = (id: string, text: string) => ({
    ...wireMessage(id, text),
    phase: "final_answer",
  });

  it("Responses continues end_turn:false text through a tool result to the final answer", async () => {
    const requests: ResponseCreateParamsStreaming[] = [];
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        requests.push(JSON.parse(rawDataToString(data)) as ResponseCreateParamsStreaming);
        const index = requests.length;
        const output =
          index === 2
            ? { ...wireCall("check", "check"), status: "completed" }
            : index === 1
              ? textItem("msg_progress", "I am checking the result.")
              : textItem("msg_final", "The check passed.");
        const event = completedWireResponse(`resp_${index}`);
        Object.assign(event.response, { end_turn: index === 3, output: [output] });
        socket.send(JSON.stringify(event));
      });
    });
    await once(server, "listening");
    const responseModel = createLoopbackModel(server);
    const apiKey = createJwt();
    const executed: string[] = [];
    try {
      const { run, events } = fixtures.captureToolLoop({
        prompt: fixtures.user("Check the result and report it."),
        tools: [fixtures.makeTool("check", executed)],
        config: { model: responseModel },
        streamFn: (_model, context, options) =>
          streamOpenAICodexResponses(responseModel, context, {
            ...options,
            apiKey,
            transport: "websocket",
          }),
      });
      const result = await run;
      expect(requests).toHaveLength(3);
      expect(executed).toEqual(["check"]);
      expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
      expect(JSON.stringify(requests)).not.toContain("openai_responses_terminal");
      expect(result.at(-1)).toMatchObject({
        role: "assistant",
        content: [expect.objectContaining({ text: "The check passed." })],
      });
      const expectInput = (index: number, item: object) =>
        expect(requests[index]?.input).toEqual(
          expect.arrayContaining([expect.objectContaining(item)]),
        );
      expectInput(1, {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [expect.objectContaining({ text: "I am checking the result." })],
      });
      expectInput(2, {
        type: "function_call_output",
        call_id: "call_check",
        output: "check result",
      });
    } finally {
      await closeServer(server, server.clients);
    }
  });
});
