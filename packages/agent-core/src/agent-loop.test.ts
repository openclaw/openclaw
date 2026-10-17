import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.js";
import {
  config,
  createTurnSequenceStream,
  makeAssistantMessage,
  makeCall,
  makeTool,
  model,
  reply,
  user,
} from "./agent-loop.test-support.js";
import { Agent } from "./agent.js";
import { TRANSCRIPT_NOT_CONTINUABLE_ERROR_CODE } from "./errors.js";
import {
  acknowledgeInternalToolResult,
  attachInternalToolBatchLifecycle,
  attachInternalToolExecutionPreparer,
  attachInternalToolResultAcknowledgement,
  attachInternalToolResultProvenance,
  getInternalToolResultProvenance,
  setInternalBeforeToolBatch,
} from "./internal-hooks.js";
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
  InternalToolBatchCall,
  StreamFn,
} from "./types.js";

function expectContaining(actual: unknown, expected: object) {
  expect(actual).toContainEqual(expect.objectContaining(expected));
}
function expectHook(hook: unknown, expected: object, signal?: AbortSignal) {
  expect(hook).toHaveBeenCalledWith(expect.objectContaining(expected), signal);
}

function eventsOf<T extends AgentEvent["type"]>(events: AgentEvent[], type: T) {
  return events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
}

function textContent(text: string) {
  return { type: "text" as const, text };
}

const text = (value: string) => [textContent(value)];
const makeToolResult = (value: string, details: object = {}) => ({ content: text(value), details });

const metadata = (message: AgentMessage | undefined) =>
  message ? (message as unknown as Record<string, unknown>)["__openclaw"] : undefined;

function resultMessages(events: AgentEvent[]) {
  return eventsOf(events, "message_end")
    .map((event) => event.message)
    .filter((message) => message.role === "toolResult");
}

function expectProvenance(value: unknown, expected: unknown) {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected a tool result");
  }
  expect(getInternalToolResultProvenance(value)).toBe(expected);
}

function executionMock(details: object = {}) {
  return vi.fn(async () => ({ content: [], details }));
}

function criticalLoopFor(toolCall: { id: string; name: string }) {
  return {
    kind: "critical-tool-loop" as const,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    actionKey: `${toolCall.name}:same-action`,
    detector: "generic_repeat",
    count: 20,
    reason: `CRITICAL: ${toolCall.name} is looping`,
  };
}

type Replies = Parameters<typeof createTurnSequenceStream>[0];
function runToolLoop(
  tools: AgentTool[],
  replies: StreamFn | Replies,
  overrides: Partial<AgentLoopConfig> = {},
  emit: Parameters<typeof runAgentLoop>[3] = () => {},
  signal?: AbortSignal,
  prompt = user(),
) {
  return runAgentLoop(
    [prompt],
    { systemPrompt: "", messages: [], tools },
    { ...config, ...overrides },
    emit,
    signal,
    typeof replies === "function" ? replies : createTurnSequenceStream(replies),
  );
}
async function runTools(
  tools: AgentTool[],
  replies: StreamFn | Replies,
  overrides: Partial<AgentLoopConfig> = {},
  signal?: AbortSignal,
) {
  const events: AgentEvent[] = [];
  const messages = await runToolLoop(
    tools,
    replies,
    overrides,
    (event) => {
      events.push(event);
    },
    signal,
  );
  return { events, messages };
}

it("persists and replays interruption guidance after Agent aborts a rejected run", async () => {
  const started = createDeferred();
  const agent = new Agent({
    initialState: { model },
    streamFn: async (_model, _context, options) => {
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("provider aborted")), {
          once: true,
        });
      });
      throw new Error("unreachable");
    },
  });
  const interrupted = agent.prompt("perform side effect");
  await started.promise;
  agent.abort();
  await interrupted;
  const guidance = { role: "custom", customType: "openclaw:turn-aborted" };
  expect(agent.state.messages.at(-1)).toMatchObject(guidance);
  let transformed: AgentMessage[] = [];
  const requests: Message[][] = [];
  agent.transformContext = async (messages) => {
    transformed = messages;
    return messages;
  };
  agent.streamFn = createTurnSequenceStream([text("continued safely")], requests);
  await agent.prompt("continue");
  expectContaining(transformed, guidance);
  expectContaining(requests[0], {
    role: "user",
    content: expect.arrayContaining([
      expect.objectContaining(textContent(expect.stringContaining("may have partially executed"))),
    ]),
  });
});

it("keeps caller messages isolated for continuations", async () => {
  const context: AgentContext = {
    systemPrompt: "",
    messages: [
      {
        role: "toolResult",
        toolCallId: "call-ready",
        toolName: "read",
        ...makeToolResult("ready"),
        isError: false,
        timestamp: 1,
      },
    ],
  };
  const originalMessages = context.messages;
  const originalSnapshot = structuredClone(context.messages);
  const events: AgentEvent[] = [];
  const content: AssistantMessage["content"] = text("new reply");
  const messages = await runAgentLoopContinue(
    context,
    config,
    (event) => {
      events.push(event);
    },
    undefined,
    () => reply(makeAssistantMessage(content)),
  );
  expect(context.messages).toBe(originalMessages);
  expect(context.messages).toEqual(originalSnapshot);
  expect(messages).toEqual([expect.objectContaining({ role: "assistant", content })]);
  expectContaining(events, {
    type: "message_end",
    message: expect.objectContaining({ role: "assistant", content }),
  });
});

it.each(["runner", "Agent"] as const)(
  "rejects an assistant-tail continuation through %s",
  async (entry) => {
    const messages = [makeAssistantMessage(text("done"))];
    const run =
      entry === "runner"
        ? runAgentLoopContinue({ systemPrompt: "", messages }, config, () => {})
        : new Agent({
            initialState: { messages },
            streamFn: () => {
              throw new Error("must not call provider");
            },
          }).continue();
    await expect(run).rejects.toMatchObject({
      code: TRANSCRIPT_NOT_CONTINUABLE_ERROR_CODE,
      role: "assistant",
    });
  },
);

it("rebuilds assistant message snapshots for text deltas without partial snapshots", async () => {
  const firstDeltaConsumed = createDeferred();
  const streamFn: StreamFn = () => {
    const stream = createAssistantMessageEventStream();
    const startMessage = makeAssistantMessage([]);
    const finalMessage = makeAssistantMessage(text("Hello world"));
    stream.push({ type: "start", partial: startMessage });
    stream.push({
      type: "text_start",
      contentIndex: 0,
      partial: { ...startMessage, content: [] },
    });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "Hello" });
    void firstDeltaConsumed.promise.then(() => {
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
  const events: AgentEvent[] = [];
  await runAgentLoop(
    [user("hello")],
    { systemPrompt: "", messages: [] },
    config,
    (event) => {
      events.push(event);
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        firstDeltaConsumed.resolve();
      }
    },
    undefined,
    streamFn,
  );
  const deltas = eventsOf(events, "message_update").filter(
    (event) => event.assistantMessageEvent.type === "text_delta",
  );
  expect(deltas).toHaveLength(2);
  expect(deltas.map((event) => event.message)).toMatchObject([
    { role: "assistant", content: text("Hello") },
    { role: "assistant", content: text("Hello world") },
  ]);
  for (const event of deltas) {
    expect(event.assistantMessageEvent).not.toHaveProperty("partial");
  }
});

it("does not execute tool calls from a max-token-truncated assistant turn", async () => {
  const execute = executionMock();
  const contexts: Context[] = [];
  const streamFn: StreamFn = (_model, context) => {
    contexts.push(context);
    if (contexts.length > 1) {
      return reply(makeAssistantMessage(text("continued")));
    }
    const call = makeCall("sessions_spawn", "call-truncated-spawn");
    const message: AssistantMessage = {
      ...makeAssistantMessage([textContent("spawning"), call]),
      stopReason: "length",
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "toolcall_start", contentIndex: 1, partial: message });
    stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial: message });
    stream.push({ type: "done", reason: "length", message });
    return stream;
  };
  const { events, messages } = await runTools(
    [{ ...makeTool("sessions_spawn"), execute }],
    streamFn,
    {
      getFollowUpMessages: async () => (contexts.length === 1 ? [user("continue", 2)] : []),
    },
  );
  const emitted = events.find(
    (event): event is Extract<AgentEvent, { type: "message_end" }> =>
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      event.message.stopReason === "length",
  );
  expect(execute).not.toHaveBeenCalled();
  expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
  expect(messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
  expect(emitted).toBeDefined();
  for (const message of [messages[1], emitted?.message, contexts[1]?.messages[1]]) {
    expect(message).toMatchObject({ role: "assistant", stopReason: "length" });
    expect(message).not.toMatchObject({
      content: expect.arrayContaining([expect.objectContaining({ type: "toolCall" })]),
    });
  }
});

it.each(["missing", "mismatched"] as const)(
  "rejects a %s deferred tool without executing it",
  async (failure) => {
    const execute = executionMock();
    const contexts: Context[] = [];
    const resolveDeferredTool = vi.fn(() =>
      failure === "missing" ? undefined : { ...makeTool("other_deferred"), execute },
    );
    const { messages } = await runTools(
      [],
      createTurnSequenceStream([[makeCall("requested_deferred")], text("done")], [], (context) => {
        contexts.push({ ...context, tools: context.tools?.slice() });
      }),
      { resolveDeferredTool },
    );
    expect(resolveDeferredTool).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(contexts.map((context) => context.tools?.map((tool) => tool.name))).toEqual([[], []]);
    expectContaining(messages, {
      role: "toolResult",
      toolName: "requested_deferred",
      isError: true,
      content: text(
        failure === "missing"
          ? "Tool requested_deferred not found"
          : 'Deferred tool resolver returned "other_deferred" for requested "requested_deferred"',
      ),
    });
  },
);

it.each(["responseId", "turnId"] as const)(
  "carries the issuing assistant %s on completions with reused call ids",
  async (identityField) => {
    const executed: string[] = [];
    const responses = [1, 2].map((turn) =>
      Object.assign(makeAssistantMessage([makeCall("lookup", "lookup_0")]), {
        responseId: identityField === "responseId" ? ` response-${turn} ` : "  ",
        turnId: ` turn-${turn} `,
      }),
    );
    const { events } = await runTools([makeTool("lookup", executed)], () =>
      reply(responses.shift() ?? makeAssistantMessage(text("done"))),
    );

    expect(executed).toEqual(["lookup", "lookup"]);
    expect(eventsOf(events, "tool_execution_end")).toMatchObject([
      {
        toolCallId: "lookup_0",
        assistantTurnId: identityField === "responseId" ? "response-1" : "turn-1",
        isError: false,
      },
      {
        toolCallId: "lookup_0",
        assistantTurnId: identityField === "responseId" ? "response-2" : "turn-2",
        isError: false,
      },
    ]);
  },
);

it("pairs every tool lifecycle before rejecting a sequential admission commit failure", async () => {
  const executed: string[] = [];
  const names = ["first", "second", "third"];
  const commitError = new Error("private admission details must not reach tool results");
  const releaseSkippedCalls = vi.fn();
  const afterToolOutcome = vi.fn(async () => undefined);
  const events: AgentEvent[] = [];

  await expect(
    runToolLoop(
      names.map((name) => makeTool(name, executed)),
      [names.map((name) => makeCall(name))],
      {
        toolExecution: "sequential",
        afterToolOutcome,
        beforeToolBatch: async () =>
          attachInternalToolBatchLifecycle(
            {},
            {
              commitReadyCalls: (calls) => {
                if (calls.some((call) => call.toolCallId === "second")) {
                  throw commitError;
                }
              },
              releaseSkippedCalls,
            },
          ),
      },
      (event) => {
        events.push(event);
      },
      undefined,
      user("run", 1),
    ),
  ).rejects.toBe(commitError);

  expect(executed).toEqual(["first"]);
  expect(releaseSkippedCalls).toHaveBeenCalledExactlyOnceWith(["second", "third"]);
  expect(eventsOf(events, "tool_execution_start").map((event) => event.toolCallId)).toEqual(names);
  const toolEnds = eventsOf(events, "tool_execution_end").map((event) => ({
    id: event.toolCallId,
    started: event.executionStarted,
  }));
  expect(toolEnds).toHaveLength(3);
  expect(toolEnds).toEqual(
    expect.arrayContaining([
      { id: "first", started: true },
      { id: "second", started: false },
      { id: "third", started: false },
    ]),
  );
  const toolResults = resultMessages(events);
  expect(toolResults.map((message) => message.toolCallId)).toEqual(names);
  for (const toolResult of toolResults.slice(1)) {
    expect(toolResult).toMatchObject({
      isError: true,
      content: text("Tool execution was blocked before launch."),
      details: { status: "blocked", deniedReason: "tool-admission" },
    });
    expect(JSON.stringify(toolResult)).not.toContain(commitError.message);
  }
  expect(afterToolOutcome).toHaveBeenCalledTimes(3);
  for (const toolCallId of ["second", "third"]) {
    expectHook(
      afterToolOutcome,
      {
        executionStarted: false,
        toolCall: expect.objectContaining({ id: toolCallId }),
      },
      undefined,
    );
  }
  expect(eventsOf(events, "turn_end")).toEqual([
    expect.objectContaining({
      message: expect.objectContaining({ role: "assistant", stopReason: "toolUse" }),
      toolResults,
    }),
  ]);
});

it("keeps Agent active until started parallel work settles after a later commit failure", async () => {
  const firstStarted = createDeferred();
  const releaseFirst = createDeferred();
  const secondCommitAttempted = createDeferred();
  const secondExecute = executionMock();
  const commitError = new Error("admission commit failed");
  const releaseSkippedCalls = vi.fn();
  const events: AgentEvent[] = [];
  let agentEnded = false;
  const agent = new Agent({
    initialState: {
      model,
      tools: [
        {
          ...makeTool("first"),
          execute: async () => {
            firstStarted.resolve();
            await releaseFirst.promise;
            return { content: [], details: { executed: "first" } };
          },
        },
        { ...makeTool("second"), execute: secondExecute },
      ],
    },
    toolExecution: "parallel",
    streamFn: vi.fn(
      createTurnSequenceStream([
        [makeCall("first", "idle-first"), makeCall("second", "idle-second")],
      ]),
    ),
  });
  setInternalBeforeToolBatch(agent, async () =>
    attachInternalToolBatchLifecycle(
      {},
      {
        commitReadyCalls: (calls) => {
          if (calls.some((call) => call.toolCallId === "idle-second")) {
            secondCommitAttempted.resolve();
            throw commitError;
          }
        },
        releaseSkippedCalls,
      },
    ),
  );
  agent.subscribe((event) => {
    events.push(event);
    agentEnded ||= event.type === "agent_end";
  });

  const prompt = agent.prompt("run");
  await firstStarted.promise;
  await secondCommitAttempted.promise;
  try {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(agentEnded).toBe(false);
    expect(agent.state.isStreaming).toBe(true);
  } finally {
    releaseFirst.resolve();
  }
  await prompt;

  expect(agent.streamFn).toHaveBeenCalledOnce();
  expect(secondExecute).not.toHaveBeenCalled();
  expect(releaseSkippedCalls).toHaveBeenCalledWith(["idle-second"]);
  expect(agent.state.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "toolResult",
    "toolResult",
    "assistant",
  ]);
  const turnEndIndex = (reason: AssistantMessage["stopReason"]) =>
    events.findIndex(
      (event) =>
        event.type === "turn_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === reason,
    );
  const toolUseTurnEnd = turnEndIndex("toolUse");
  const failureTurnEnd = turnEndIndex("error");
  const agentEnd = events.findIndex((event) => event.type === "agent_end");
  expect(toolUseTurnEnd).toBeGreaterThanOrEqual(0);
  expect(failureTurnEnd).toBeGreaterThan(toolUseTurnEnd);
  expect(agentEnd).toBeGreaterThan(failureTurnEnd);
  expect(events.slice(agentEnd + 1)).toEqual([]);
});

it.each([false, true])(
  "preserves tool outcomes through hooks and warnings (missing content: %s)",
  async (missingContent) => {
    const executed: string[] = [];
    const requestMessages: Message[][] = [];
    const rawOutcomes = new Map<string, number[]>();
    const recordRaw = (id: string, result: AgentToolResult<unknown>) => {
      rawOutcomes.set(id, [...(rawOutcomes.get(id) ?? []), result.content?.length ?? 0]);
    };
    const streamFn = createTurnSequenceStream(
      [
        [makeCall("read", "warned"), makeCall("list", "sibling")],
        [makeCall("read", "next")],
        text("done"),
      ],
      requestMessages,
    );
    const read = makeTool("read", executed);
    const executeRead = read.execute;
    read.resultContentSource = "network";
    read.execute = async (...args) => {
      const result = await executeRead(...args);
      return missingContent && args[0] === "warned"
        ? ({ details: { ok: true } } as AgentToolResult<unknown>)
        : result;
    };
    const { events, messages } = await runTools([read, makeTool("list", executed)], streamFn, {
      toolExecution: "parallel",
      beforeToolBatch: async ({ calls }) => ({
        warnings: calls
          .filter(({ toolCall }) => toolCall.id === "warned")
          .map(({ toolCall }) => ({
            kind: "tool-loop-warning" as const,
            toolCallId: toolCall.id,
            count: 10,
          })),
      }),
      afterToolCall: async ({ toolCall, result }) => {
        recordRaw(toolCall.id, result);
      },
      afterToolOutcome: async ({ toolCall, result }) => {
        recordRaw(toolCall.id, result);
        return result.content
          ? { content: [...result.content, textContent("outcome hook")] }
          : undefined;
      },
    });
    expect(Object.fromEntries(rawOutcomes)).toEqual({
      warned: missingContent ? [0, 0] : [1, 1],
      sibling: [1, 1],
      next: [1, 1],
    });
    const results = requestMessages.at(-1)?.filter((message) => message.role === "toolResult");
    expect(results?.map((message) => message.content)).toEqual([
      [
        ...(missingContent ? [] : [textContent("read result"), textContent("outcome hook")]),
        textContent(
          "[System note: Tool-loop warning after 10 repeated calls. Change your approach or stop if you are not making progress.]",
        ),
      ],
      [textContent("list result"), textContent("outcome hook")],
      [textContent("read result"), textContent("outcome hook")],
    ]);
    expect(eventsOf(events, "tool_execution_end").map((event) => event.result)).toEqual(
      results?.map((message) => expect.objectContaining({ content: message.content })),
    );
    expect(executed).toEqual(["read", "list", "read"]);
    expect(requestMessages).toHaveLength(3);
    expect(metadata(messages.find((message) => message.role === "toolResult"))).toEqual({
      resultContentSource: "network",
    });
    expect(metadata(messages.findLast((message) => message.role === "assistant"))).toEqual({
      turnTainted: true,
    });
  },
);

it("stops pre-admission validation after cancellation and aborts the untouched tail", async () => {
  const controller = new AbortController();
  const executed: string[] = [];
  const resolverCalls: string[] = [];

  const streamFn = vi.fn(
    createTurnSequenceStream([
      [
        makeCall("d_first_tool", "d-first"),
        makeCall("d_second_tool", "d-second"),
        makeCall("d_third_tool", "d-third"),
      ],
    ]),
  );
  const { events } = await runTools(
    [],
    streamFn,
    {
      resolveDeferredTool: async ({ toolCall }) => {
        resolverCalls.push(toolCall.name);
        if (toolCall.name === "d_first_tool") {
          // The run is cancelled while the first async resolver is in
          // flight; later resolvers must never be awaited.
          controller.abort(new Error("user aborted"));
        }
        return makeTool(toolCall.name, executed);
      },
      beforeToolBatch: async () => undefined,
    },
    controller.signal,
  );

  expect(streamFn).toHaveBeenCalledOnce();
  expect(resolverCalls).toEqual(["d_first_tool"]);
  expect(executed).toEqual([]);
  const toolResults = resultMessages(events);
  expect(toolResults).toHaveLength(3);
  for (const toolResult of toolResults) {
    expect(toolResult).toMatchObject({
      isError: true,
      content: text("Operation aborted"),
    });
  }
});

it("executes a different recovery action and keeps the one-shot budget spent", async () => {
  const executed: string[] = [];
  let turn = 0;
  const providerTools: string[][] = [];
  const streamFn = createTurnSequenceStream(
    [
      [makeCall("read", "loop-1")],
      [makeCall("list", "safe-1")],
      [makeCall("list", "blocked-sibling"), makeCall("read", "loop-2")],
    ],
    [],
    (context, currentTurn) => {
      providerTools.push(context.tools?.map((tool) => tool.name) ?? []);
      turn = currentTurn;
    },
  );
  const { events } = await runTools(
    [{ ...makeTool("read", executed), resultContentSource: "network" }, makeTool("list", executed)],
    streamFn,
    {
      beforeToolBatch: async ({ calls }) => {
        const repeated = calls.find((call) => call.toolCall.name === "read");
        return repeated ? { intervention: criticalLoopFor(repeated.toolCall) } : undefined;
      },
    },
  );

  expect(turn).toBe(3);
  expect(executed).toEqual(["list"]);
  expect(providerTools).toEqual([
    ["read", "list"],
    ["read", "list"],
    ["read", "list"],
  ]);
  for (const event of events) {
    if (event.type === "message_end") {
      expect(event.message).not.toHaveProperty("__openclaw");
    }
  }
  expect(events.at(-1)).toMatchObject({ type: "agent_end" });
  const toolEnds = eventsOf(events, "tool_execution_end");
  expect(toolEnds.map((event) => event.executionStarted)).toEqual([false, true, false, false]);
  expect(toolEnds[0]).toMatchObject({
    isError: true,
    result: { details: { status: "blocked", deniedReason: "tool-loop" } },
  });
  expect(toolEnds.at(-1)?.result).toMatchObject({ terminate: true });
  expect(
    events.find(
      (event) =>
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "error",
    ),
  ).toMatchObject({
    message: {
      content: text(
        expect.stringContaining("tool-loop recovery encountered another critical loop"),
      ),
    },
  });
});

it("preserves the recovery budget across continue retries and resets it for a new prompt", async () => {
  let phase: "initial" | "retry" | "new-prompt" = "initial";
  let phaseCalls = 0;
  const streamFn: StreamFn = () => {
    phaseCalls += 1;
    const message =
      phase === "initial" && phaseCalls === 2
        ? {
            ...makeAssistantMessage([]),
            stopReason: "error" as const,
            errorMessage: "retryable provider failure",
          }
        : phase === "new-prompt" && phaseCalls === 2
          ? makeAssistantMessage(text("recovered on the new run"))
          : makeAssistantMessage([makeCall("read", `${phase}-${phaseCalls}`)]);
    return reply(message);
  };
  const agent = new Agent({
    initialState: { model, systemPrompt: "", tools: [makeTool("read")] },
    streamFn,
  });
  setInternalBeforeToolBatch(agent, async ({ calls }) => {
    const first = calls[0];
    return first ? { intervention: criticalLoopFor(first.toolCall) } : undefined;
  });

  await agent.prompt("run");
  expect(phaseCalls).toBe(2);
  expect(agent.state.messages.at(-1)).toMatchObject({
    role: "assistant",
    stopReason: "error",
    errorMessage: "retryable provider failure",
  });

  agent.state.messages = agent.state.messages.slice(0, -1);
  phase = "retry";
  phaseCalls = 0;
  await agent.continue();

  expect(phaseCalls).toBe(1);
  expect(agent.state.messages.at(-1)).toMatchObject({
    role: "assistant",
    stopReason: "error",
    content: text(expect.stringContaining("tool-loop recovery encountered another critical loop")),
  });

  phase = "new-prompt";
  phaseCalls = 0;
  await agent.prompt("new run");

  expect(phaseCalls).toBe(2);
  expect(agent.state.messages.at(-1)).toMatchObject({
    role: "assistant",
    stopReason: "stop",
    content: text("recovered on the new run"),
  });
});

it.each(["execute", "prepare", "immediate", "after-call"] as const)(
  "preserves only operation-owned error provenance at %s",
  async (phase) => {
    const provenance = { source: "operation-effect-proof" };
    const failure = attachInternalToolResultProvenance(new Error("operation rejected"), provenance);
    const tool: AgentTool = {
      ...makeTool("operation"),
      execute: async () => {
        if (phase === "execute") {
          throw failure;
        }
        return makeToolResult("completed");
      },
    };
    if (phase === "prepare" || phase === "immediate") {
      attachInternalToolExecutionPreparer(tool, async () => {
        if (phase === "prepare") {
          throw failure;
        }
        return { kind: "immediate", outcome: { kind: "error", error: failure }, dispose() {} };
      });
    }
    const { events } = await runTools(
      [tool],
      [[makeCall(tool.name, "operation-call")], text("recovered")],
      phase === "after-call"
        ? {
            afterToolCall: async () => {
              throw failure;
            },
          }
        : {},
    );
    const end = eventsOf(events, "tool_execution_end")[0];
    expect(end?.isError).toBe(true);
    expectProvenance(end?.result, phase === "after-call" ? undefined : provenance);
  },
);

it.each([
  { name: "attached", failAttachment: false, expectedAcknowledgements: 1 },
  { name: "dropped", failAttachment: true, expectedAcknowledgements: 0 },
])("acknowledges an internal tool result only after it is $name", async (testCase) => {
  const acknowledge = vi.fn();
  const provenance = { source: "test-tool-result-provenance" };
  const extra = { deliveryId: "delivery-1" };
  const order: string[] = [];
  const tool: AgentTool = {
    ...makeTool("commit_probe"),
    execute: async () =>
      attachInternalToolResultProvenance(
        attachInternalToolResultAcknowledgement(
          {
            content: text("committed"),
            details: { phase: "execute" },
            extra,
          },
          acknowledge,
        ),
        provenance,
      ),
  };

  const run = runToolLoop(
    [tool],
    [[makeCall(tool.name, "commit-probe")], text("done")],
    {
      beforeToolBatch: async () => ({
        warnings: [{ kind: "tool-loop-warning", toolCallId: "commit-probe", count: 10 }],
      }),
      afterToolCall: async () => {
        order.push("afterToolCall");
        return { details: { phase: "after-call" } };
      },
      afterToolOutcome: async ({ result, executionStarted }) => {
        order.push("afterToolOutcome");
        expect(result.details).toEqual({ phase: "after-call" });
        expect(executionStarted).toBe(true);
        return { details: { phase: "after-outcome" } };
      },
    },
    async (event) => {
      if (event.type === "tool_execution_end") {
        expect(event.result).toMatchObject({
          extra,
          details: { phase: "after-outcome" },
          content: [
            textContent("committed"),
            textContent(expect.stringContaining("Tool-loop warning after 10")),
          ],
        });
        expectProvenance(event.result, provenance);
      }
      if (event.type === "message_end" && event.message.role === "toolResult") {
        if (testCase.failAttachment) {
          throw new Error("attachment failed");
        }
        expect(getInternalToolResultProvenance(event.message)).toBe(provenance);
        acknowledgeInternalToolResult(event.message);
      }
    },
    undefined,
    user("commit", 1),
  );

  if (testCase.failAttachment) {
    await expect(run).rejects.toThrow("attachment failed");
  } else {
    await run;
  }
  expect(acknowledge).toHaveBeenCalledTimes(testCase.expectedAcknowledgements);
  expect(order).toEqual(["afterToolCall", "afterToolOutcome"]);
});

it.each([
  ["parallel", "policy-blocked", false],
  ["sequential", "caller cancellation", false],
  ["parallel", "remote failure after cancellation", true],
] as const)("preserves %s provenance for %s", async (toolExecution, failure, tainted) => {
  const blocked = failure === "policy-blocked";
  const controller = new AbortController();
  const cancelReason = new Error("operator cancelled");
  const afterToolCall = vi.fn(async () => undefined);
  const executed: string[] = [];
  const tool: AgentTool = {
    ...makeTool("network"),
    resultContentSource: "network",
    execute: async () => {
      executed.push("network");
      controller.abort(cancelReason);
      throw tainted ? new Error("remote failure after cancellation") : cancelReason;
    },
  };
  const { events, messages } = await runTools(
    [tool],
    [[makeCall(tool.name, "network-call")], ...(blocked ? [text("local outcome")] : [])],
    {
      toolExecution,
      afterToolCall,
      ...(blocked ? { beforeToolCall: async () => ({ block: true, reason: "local policy" }) } : {}),
    },
    controller.signal,
  );
  expect(executed).toEqual(blocked ? [] : ["network"]);
  expect(afterToolCall).toHaveBeenCalledTimes(blocked ? 0 : 1);
  expectContaining(events, { type: "tool_execution_end", executionStarted: !blocked });
  expect(metadata(messages.find((message) => message.role === "toolResult"))).toEqual(
    tainted ? { resultContentSource: "network" } : undefined,
  );
  if (blocked) {
    expect(metadata(messages.findLast((message) => message.role === "assistant"))).toBeUndefined();
  }
});

it("ignores progress updates after a tool execution settles", async () => {
  let delayedUpdate: ((result: AgentToolResult<unknown>) => void) | undefined;
  const tool: AgentTool = {
    ...makeTool("delayed_tool"),
    description: "captures progress callbacks",
    hideFromChannelProgress: true,
    execute: async (_toolCallId, _args, _signal, onUpdate) => {
      delayedUpdate = onUpdate;
      onUpdate?.(makeToolResult("running", { status: "running" }));
      return { ...makeToolResult("done", { status: "done" }), terminate: true };
    },
  };

  const { events } = await runTools([tool], [[makeCall(tool.name, "call-delayed")]], {
    toolExecution: "sequential",
  });
  const lifecycleEvents = events.filter((event) => event.type.startsWith("tool_execution_"));

  expect(lifecycleEvents.map((event) => event.type)).toEqual([
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
  ]);
  expect(
    lifecycleEvents.every(
      (event) => "hideFromChannelProgress" in event && event.hideFromChannelProgress === true,
    ),
  ).toBe(true);
  const countAfterRun = events.length;
  delayedUpdate?.(makeToolResult("late", { status: "late" }));
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

  expect(events).toHaveLength(countAfterRun);
  expect(eventsOf(events, "tool_execution_update")).toHaveLength(1);
});

it("preserves a terminal result when the finalized-outcome hook throws", async () => {
  const executed: string[] = [];
  const streamFn = vi.fn(
    createTurnSequenceStream([
      [makeCall("message", "call-message")],
      [makeCall("exec", "call-exec")],
    ]),
  );

  const { events } = await runTools(
    [makeTool("message", executed), makeTool("exec", executed)],
    streamFn,
    {
      afterToolCall: async ({ toolCall }) =>
        toolCall.name === "message" ? { terminate: true } : undefined,
      afterToolOutcome: async () => {
        throw attachInternalToolResultProvenance(new Error("finalized hook failed"), {
          source: "hook",
        });
      },
    },
  );

  expect(streamFn).toHaveBeenCalledOnce();
  expect(executed).toEqual(["message"]);
  expect(eventsOf(events, "tool_execution_start")).toHaveLength(1);
  expect(eventsOf(events, "tool_execution_end")[0]?.result).toMatchObject({
    content: text("finalized hook failed"),
    terminate: true,
  });
  const terminal = eventsOf(events, "tool_execution_end")[0];
  expectProvenance(terminal?.result, undefined);
  expect(events.at(-1)).toMatchObject({ type: "agent_end" });
});

it.each(["sequential", "parallel"] as const)(
  "pairs aborted tails in %s batches (#116379)",
  async (toolExecution) => {
    const controller = new AbortController();
    const afterToolOutcome = vi.fn(async () => undefined);
    const skippedExecute = vi.fn(async () => {
      throw new Error("skipped tool must not execute");
    });
    const tools: AgentTool[] = [
      {
        ...makeTool("first"),
        execute: async () => {
          controller.abort(new Error("user aborted"));
          return makeToolResult("first ran", { aborted: true });
        },
      },
      ...["second", "third"].map((name) =>
        Object.assign(makeTool(name), { hideFromChannelProgress: true, execute: skippedExecute }),
      ),
    ];
    const requests: Message[][] = [];
    const { events, messages } = await runTools(
      tools,
      createTurnSequenceStream(
        [[makeCall("first"), makeCall("second"), makeCall("third")]],
        requests,
      ),
      { toolExecution, afterToolOutcome },
      controller.signal,
    );
    expect(requests).toHaveLength(1);
    expect(skippedExecute).not.toHaveBeenCalled();
    expect(messages.filter((message) => message.role === "toolResult")).toMatchObject([
      { toolCallId: "first", isError: false },
      ...["second", "third"].map((toolCallId) => ({
        toolCallId,
        isError: true,
        content: text("Operation aborted"),
      })),
    ]);
    expect(afterToolOutcome).toHaveBeenCalledTimes(3);
    for (const id of ["first", "second", "third"]) {
      const start = events.findIndex(
        (event) => event.type === "tool_execution_start" && event.toolCallId === id,
      );
      const end = events.findIndex(
        (event) => event.type === "tool_execution_end" && event.toolCallId === id,
      );
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      if (id !== "first") {
        expect(events[start]).toMatchObject({ hideFromChannelProgress: true });
        expect(events[end]).toMatchObject({
          hideFromChannelProgress: true,
          executionStarted: false,
        });
        expectHook(
          afterToolOutcome,
          {
            toolCall: expect.objectContaining({ id }),
            isError: true,
            executionStarted: false,
          },
          controller.signal,
        );
      }
    }
    expect(eventsOf(events, "tool_execution_start")).toHaveLength(3);
    expect(eventsOf(events, "tool_execution_end")).toHaveLength(3);
    expect(messages.at(-2)).toMatchObject({ role: "assistant", stopReason: "aborted" });
    expect(messages.at(-1)).toMatchObject({
      role: "custom",
      customType: "openclaw:turn-aborted",
      display: false,
      content: expect.stringContaining("may have partially executed"),
    });
    expect(events.at(-1)).toMatchObject({ type: "agent_end" });
  },
);

it("skips interrupted-turn guidance when the abort reason marks a turn handoff", async () => {
  const controller = new AbortController();

  const streamFn = vi.fn(createTurnSequenceStream([[makeCall("yield_tool", "call-yield")]]));
  const yieldTool: AgentTool = {
    ...makeTool("yield_tool"),
    description: "Yield the active run as a clean handoff",
    execute: async () => {
      controller.abort({ code: "sessions_yield", turnHandoff: true });
      return makeToolResult("yielded", { yielded: true });
    },
  };

  const { messages } = await runTools([yieldTool], streamFn, {}, controller.signal);

  expect(streamFn).toHaveBeenCalledOnce();
  expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
  expect(messages.some((message) => message.role === "custom")).toBe(false);
});

it("does not start prepared parallel tools after the run aborts mid-batch", async () => {
  const controller = new AbortController();
  const executed: string[] = [];
  const afterToolCall = vi.fn(async () => undefined);
  const commitReadyCalls = vi.fn();
  const releaseSkippedCalls = vi.fn();

  const { messages: abortedMessages, events } = await runTools(
    [
      { ...makeTool("paid", executed), resultContentSource: "network" },
      { ...makeTool("gated", executed), resultContentSource: "network" },
    ],
    [[makeCall("paid", "call-paid"), makeCall("gated", "call-gated")]],
    {
      toolExecution: "parallel",
      beforeToolBatch: async () =>
        attachInternalToolBatchLifecycle({}, { commitReadyCalls, releaseSkippedCalls }),
      beforeToolCall: async ({ toolCall }) => {
        if (toolCall.name === "gated") {
          await Promise.resolve();
          controller.abort(new Error("user aborted"));
        }
        return undefined;
      },
      afterToolCall,
    },
    controller.signal,
  );

  const endEvents = eventsOf(events, "tool_execution_end");

  expect(executed).toEqual([]);
  expect(afterToolCall).not.toHaveBeenCalled();
  expect(commitReadyCalls).not.toHaveBeenCalled();
  expect(releaseSkippedCalls).not.toHaveBeenCalled();
  expect(
    abortedMessages
      .filter((message) => message.role === "toolResult")
      .every((message) => !(message as unknown as { __openclaw?: unknown })["__openclaw"]),
  ).toBe(true);
  expect(endEvents).toHaveLength(2);
  expect(endEvents).toEqual(
    expect.arrayContaining(
      ["paid", "gated"].map((toolName) =>
        expect.objectContaining({
          toolName,
          isError: true,
          executionStarted: false,
          result: expect.objectContaining({ content: text("Operation aborted") }),
        }),
      ),
    ),
  );
});

it("does not request another model turn when an async turn hook aborts the run", async () => {
  const controller = new AbortController();

  const streamFn = vi.fn(createTurnSequenceStream([[makeCall("hook_abort", "call-hook-abort")]]));
  const { messages, events } = await runTools(
    [makeTool("hook_abort")],
    streamFn,
    {
      prepareNextTurn: async () => {
        await Promise.resolve();
        controller.abort(new Error("user aborted"));
        return undefined;
      },
    },
    controller.signal,
  );

  expect(streamFn).toHaveBeenCalledOnce();
  expect(messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "toolResult",
    "assistant",
    "custom",
  ]);
  expect(messages.at(-2)).toMatchObject({ role: "assistant", stopReason: "aborted" });
  expect(messages.at(-1)).toMatchObject({
    role: "custom",
    customType: "openclaw:turn-aborted",
  });
  const messagePair = ["message_start", "message_end"];
  expect(events.map((event) => event.type)).toEqual([
    "agent_start",
    "turn_start",
    ...messagePair,
    ...messagePair,
    "tool_execution_start",
    "tool_execution_end",
    ...messagePair,
    "turn_end",
    "turn_start",
    ...messagePair,
    "turn_end",
    ...messagePair,
    "agent_end",
  ]);
  expect(events.at(-1)).toMatchObject({ type: "agent_end" });
});

it("forwards completed-turn context and applies its update to the following request", async () => {
  const nextModel: Model = { ...model, id: "next-model", thinkingLevelMap: { off: "low" } };
  const requests: Array<{
    model: string;
    systemPrompt: string;
    tools: string[];
    reasoning: string | undefined;
  }> = [];
  let turn = 0;
  const streamFn: StreamFn = (activeModel, context, options) => {
    requests.push({
      model: activeModel.id,
      reasoning: options?.reasoning,
      systemPrompt: context.systemPrompt ?? "",
      tools: context.tools?.map((tool) => tool.name) ?? [],
    });
    turn += 1;
    const content: AssistantMessage["content"] =
      turn === 1 ? [makeCall("refresh", "call-refresh")] : text("done");
    return reply({
      ...makeAssistantMessage(content),
      api: activeModel.api,
      provider: activeModel.provider,
      model: activeModel.id,
      timestamp: turn,
    });
  };
  const tool: AgentTool = {
    ...makeTool("refresh"),
    description: "refresh turn state",
    execute: async () => makeToolResult("refreshed"),
  };
  const prepareNextTurnWithContext = vi.fn(({ context }) => ({
    context: { ...context, systemPrompt: "refreshed prompt", tools: [] },
    model: nextModel,
  }));
  const prepareNextTurn = vi.fn(() => ({
    context: { systemPrompt: "legacy prompt", messages: [], tools: [tool] },
  }));
  const agent = new Agent({
    initialState: { model, systemPrompt: "initial prompt", tools: [tool] },
    convertToLlm: (messages) => messages as Message[],
    streamFn,
    prepareNextTurn,
    prepareNextTurnWithContext,
  });

  await agent.prompt("start");

  expect(prepareNextTurnWithContext).toHaveBeenCalled();
  expect(prepareNextTurn).not.toHaveBeenCalled();
  expect(prepareNextTurnWithContext.mock.calls[0]?.[0]).toMatchObject({
    message: { role: "assistant", stopReason: "toolUse" },
    toolResults: [{ role: "toolResult", toolName: "refresh" }],
  });
  expect(requests).toEqual([
    { model: model.id, systemPrompt: "initial prompt", tools: ["refresh"], reasoning: "off" },
    { model: nextModel.id, systemPrompt: "refreshed prompt", tools: [], reasoning: "low" },
  ]);
});

it("admits argument-validation failures so a repeated rejected call reaches loop recovery", async () => {
  const executed: string[] = [];
  const admittedCalls: InternalToolBatchCall[][] = [];
  const { events } = await runTools(
    [
      {
        ...makeTool("edit", executed),
        parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
      },
    ],
    [[makeCall("edit", "invalid-1")], text("recovered")],
    {
      beforeToolBatch: async ({ calls }) => {
        admittedCalls.push(calls);
        const first = calls[0];
        return first ? { intervention: criticalLoopFor(first.toolCall) } : undefined;
      },
    },
  );

  expect(admittedCalls).toEqual([
    [
      {
        toolCall: expect.objectContaining({ id: "invalid-1", name: "edit" }),
        args: {},
        validationFailure: {
          content: text(expect.stringContaining("path")),
          details: {},
        },
      },
    ],
  ]);
  expect(executed).toEqual([]);
  expect(resultMessages(events)).toMatchObject([
    {
      toolCallId: "invalid-1",
      isError: true,
      details: { status: "blocked", deniedReason: "tool-loop" },
    },
  ]);
  expect(
    events.filter((event) => event.type === "message_end" && event.message.role === "assistant"),
  ).toHaveLength(2);
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
