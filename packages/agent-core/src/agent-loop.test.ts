// Agent Core tests cover agent loop behavior.
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.js";
import { captureAgentLoop, collectEvents } from "./agent-loop.test-support.js";
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
  AfterToolOutcomeContext,
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

function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: TEST_USAGE,
    stopReason: content.some((item) => item.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 1,
  };
}

function makeTool(name: string, executed: string[] = []): AgentTool {
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

function createTurnSequenceStream(
  turns: AssistantMessage["content"][],
  requestMessages: Message[][] = [],
  onRequest?: (context: Context, turn: number) => void,
): StreamFn {
  let turnIndex = 0;
  return (_activeModel, context) => {
    requestMessages.push(context.messages.slice());
    onRequest?.(context, turnIndex + 1);
    const content = turns[turnIndex];
    turnIndex += 1;
    if (!content) {
      throw new Error(`unexpected provider request ${turnIndex}`);
    }
    return reply(makeAssistantMessage(content));
  };
}

function reply(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } else {
      stream.push({ type: "done", reason: message.stopReason, message });
    }
    stream.end();
  });
  return stream;
}

function user(content = "run", timestamp = 1): AgentMessage {
  return { role: "user", content, timestamp };
}

function makeCall(
  name: string,
  id = name,
): Extract<AssistantMessage["content"][number], { type: "toolCall" }> {
  return { type: "toolCall", id, name, arguments: {} };
}

function makeResult(): Extract<AgentMessage, { role: "toolResult" }> {
  return {
    role: "toolResult",
    toolCallId: "call-ready",
    toolName: "read",
    content: [{ type: "text", text: "ready" }],
    details: {},
    isError: false,
    timestamp: 1,
  };
}

function captureTools(
  tools: AgentTool[],
  streamFn: StreamFn,
  overrides: Partial<AgentLoopConfig> = {},
  signal?: AbortSignal,
) {
  return captureAgentLoop(
    [user()],
    { systemPrompt: "", messages: [], tools },
    { ...config, ...overrides },
    signal,
    streamFn,
  );
}

describe("Agent lifecycle and continuation", () => {
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
    agent.streamFn = createTurnSequenceStream(
      [[{ type: "text", text: "continued safely" }]],
      requests,
    );
    await agent.prompt("continue");
    expect(transformed).toContainEqual(expect.objectContaining(guidance));
    expect(requests[0]).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("may have partially executed"),
          }),
        ]),
      }),
    );
  });

  it("keeps caller messages isolated for continuations", async () => {
    const context: AgentContext = { systemPrompt: "", messages: [makeResult()] };
    const originalMessages = context.messages;
    const originalSnapshot = structuredClone(context.messages);
    const events: AgentEvent[] = [];
    const content: AssistantMessage["content"] = [{ type: "text", text: "new reply" }];
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
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message_end",
        message: expect.objectContaining({ role: "assistant", content }),
      }),
    );
  });

  it.each(["runner", "Agent"] as const)(
    "rejects an assistant-tail continuation through %s",
    async (entry) => {
      const messages = [makeAssistantMessage([{ type: "text", text: "done" }])];
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

  it.each(["toolResult", "user"] as const)(
    "orders queued follow-ups behind a %s continuation",
    async (tail) => {
      const requests: Message[][] = [];
      const followUp = user("queued after end", 2);
      const original = tail === "user" ? user("retry this turn") : makeResult();
      const agent = new Agent({
        initialState: { model, messages: [original] },
        streamFn: createTurnSequenceStream(
          [[{ type: "text", text: "answer 1" }], [{ type: "text", text: "answer 2" }]],
          requests,
        ),
      });
      agent.followUp(followUp);
      await agent.continue();
      expect(requests).toHaveLength(tail === "user" ? 2 : 1);
      expect(requests[0]?.at(-1)).toEqual(tail === "user" ? original : followUp);
      expect(requests.at(-1)?.at(-1)).toBe(followUp);
    },
  );
});

describe("agentLoop streaming updates", () => {
  it("rebuilds assistant message snapshots for text deltas without partial snapshots", async () => {
    const firstDeltaConsumed = createDeferred();
    const streamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      const startMessage = makeAssistantMessage([]);
      const finalMessage = makeAssistantMessage([{ type: "text", text: "Hello world" }]);
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
    const deltas = events.filter(
      (event): event is Extract<AgentEvent, { type: "message_update" }> =>
        event.type === "message_update" && event.assistantMessageEvent.type === "text_delta",
    );
    expect(deltas).toHaveLength(2);
    expect(deltas.map((event) => event.message)).toMatchObject([
      { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hello world" }] },
    ]);
    for (const event of deltas) {
      expect(event.assistantMessageEvent).not.toHaveProperty("partial");
    }
  });

  it("does not execute tool calls from a max-token-truncated assistant turn", async () => {
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const contexts: Context[] = [];
    const streamFn: StreamFn = (_model, context) => {
      contexts.push(context);
      if (contexts.length > 1) {
        return reply(makeAssistantMessage([{ type: "text", text: "continued" }]));
      }
      const call = makeCall("sessions_spawn", "call-truncated-spawn");
      const message: AssistantMessage = {
        ...makeAssistantMessage([{ type: "text", text: "spawning" }, call]),
        stopReason: "length",
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "toolcall_start", contentIndex: 1, partial: message });
      stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial: message });
      stream.push({ type: "done", reason: "length", message });
      return stream;
    };
    const run = captureTools([{ ...makeTool("sessions_spawn"), execute }], streamFn, {
      getFollowUpMessages: async () => (contexts.length === 1 ? [user("continue", 2)] : []),
    });
    const events = await collectEvents(run);
    const messages = await run.result;
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
});

describe("deferred tool hydration", () => {
  it.each(["missing", "mismatched"] as const)(
    "rejects a %s deferred tool without executing it",
    async (failure) => {
      const execute = vi.fn(async () => ({ content: [], details: {} }));
      const contexts: Context[] = [];
      const resolveDeferredTool = vi.fn(() =>
        failure === "missing" ? undefined : { ...makeTool("other_deferred"), execute },
      );
      const run = captureTools(
        [],
        createTurnSequenceStream(
          [[makeCall("requested_deferred")], [{ type: "text", text: "done" }]],
          [],
          (context) => {
            contexts.push({ ...context, tools: context.tools?.slice() });
          },
        ),
        { resolveDeferredTool },
      );
      const messages = await run.result;
      expect(resolveDeferredTool).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
      expect(contexts.map((context) => context.tools?.map((tool) => tool.name))).toEqual([[], []]);
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: "toolResult",
          toolName: "requested_deferred",
          isError: true,
          content: [
            {
              type: "text",
              text:
                failure === "missing"
                  ? "Tool requested_deferred not found"
                  : 'Deferred tool resolver returned "other_deferred" for requested "requested_deferred"',
            },
          ],
        }),
      );
    },
  );

  it("hydrates sequential deferred tools before choosing the executor and continuation catalog", async () => {
    let active = 0;
    let maxActive = 0;
    const contexts: Context[] = [];
    const execute = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
      active -= 1;
      return { content: [{ type: "text" as const, text: "hidden ok" }], details: { ok: true } };
    });
    const hiddenTool: AgentTool = {
      ...makeTool("hidden_serial"),
      parameters: Type.Object({ query: Type.String() }),
      executionMode: "sequential",
      execute,
    };
    const resolveDeferredTool = vi.fn(() => hiddenTool);
    vi.useFakeTimers();
    try {
      const run = captureTools(
        [],
        createTurnSequenceStream(
          [
            [
              { ...makeCall("hidden_serial", "first"), arguments: { query: "one" } },
              { ...makeCall("hidden_serial", "second"), arguments: { query: "two" } },
            ],
            [{ type: "text", text: "done" }],
          ],
          [],
          (context) => {
            contexts.push({ ...context, tools: context.tools?.slice() });
          },
        ),
        { resolveDeferredTool },
      );
      await vi.runAllTimersAsync();
      expect((await run.result).some((message) => message.role === "toolResult")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(resolveDeferredTool).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(
      1,
      "first",
      { query: "one" },
      undefined,
      expect.any(Function),
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      "second",
      { query: "two" },
      undefined,
      expect.any(Function),
    );
    expect(maxActive).toBe(1);
    expect(contexts.map((context) => context.tools?.map((tool) => tool.name))).toEqual([
      [],
      ["hidden_serial"],
    ]);
  });
});

describe("agentLoop tool termination", () => {
  it("makes a queued steer visible before the next sequential tool starts", async () => {
    const firstReleased = createDeferred();
    const firstStarted = createDeferred();
    const firstExecute = vi.fn(async () => {
      firstStarted.resolve();
      await firstReleased.promise;
      return { content: [{ type: "text" as const, text: "first result" }], details: {} };
    });
    const secondExecute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "second result" }],
      details: {},
    }));
    const requestMessages: Message[][] = [];
    const streamFn = createTurnSequenceStream(
      [
        [makeCall("first", "call-first"), makeCall("second", "call-second")],
        [{ type: "text", text: "handled steer 1" }],
        [{ type: "text", text: "handled steer 2" }],
      ],
      requestMessages,
    );
    const afterToolOutcome = vi.fn(async (_context: AfterToolOutcomeContext) => undefined);
    const commitReadyCalls = vi.fn();
    const releaseSkippedCalls = vi.fn();
    const events: AgentEvent[] = [];
    const agent = new Agent({
      initialState: {
        model,
        tools: [
          {
            ...makeTool("first"),
            execute: firstExecute,
          },
          {
            ...makeTool("second"),
            execute: secondExecute,
            resultContentSource: "network",
          },
        ],
      },
      streamFn,
      toolExecution: "sequential",
      afterToolOutcome,
    });
    setInternalBeforeToolBatch(agent, async () =>
      attachInternalToolBatchLifecycle({}, { commitReadyCalls, releaseSkippedCalls }),
    );
    agent.subscribe((event) => {
      events.push(event);
    });
    const firstSteer = { role: "user" as const, content: "steer one", timestamp: 2 };
    const secondSteer = { role: "user" as const, content: "steer two", timestamp: 3 };

    const run = agent.prompt("start");
    await firstStarted.promise;
    agent.steer(firstSteer);
    agent.steer(secondSteer);
    firstReleased.resolve();
    await run;

    expect(firstExecute).toHaveBeenCalledOnce();
    expect(secondExecute).not.toHaveBeenCalled();
    expect(commitReadyCalls).toHaveBeenCalledExactlyOnceWith([
      { toolCallId: "call-first", args: {} },
    ]);
    expect(releaseSkippedCalls).toHaveBeenCalledWith(["call-second"]);
    expect(requestMessages).toHaveLength(3);
    expect(agent.state.messages.slice(1, 5)).toMatchObject([
      { role: "assistant", stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "call-first", isError: false },
      { role: "toolResult", toolCallId: "call-second", isError: true },
      firstSteer,
    ]);
    expect(requestMessages[1]?.slice(-4)).toMatchObject([
      { role: "assistant", stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "call-first", isError: false },
      {
        role: "toolResult",
        toolCallId: "call-second",
        isError: true,
        content: [{ type: "text", text: "Skipped to process an incoming message." }],
        details: { status: "skipped", deniedReason: "steering" },
      },
      firstSteer,
    ]);
    expect(requestMessages[1]?.at(-1)).toBe(firstSteer);
    expect(requestMessages[1]).not.toContain(secondSteer);
    expect(requestMessages[2]?.at(-1)).toBe(secondSteer);
    const queuedMessageStarts = events.filter(
      (event): event is Extract<AgentEvent, { type: "message_start" }> =>
        event.type === "message_start" && event.message.role === "user",
    );
    expect(queuedMessageStarts.at(-2)?.message).toBe(firstSteer);
    expect(queuedMessageStarts.at(-1)?.message).toBe(secondSteer);
    expect(
      requestMessages[1]?.find((message) => message.role === "toolResult" && message.isError),
    ).not.toHaveProperty("__openclaw");
    expect(afterToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCall: expect.objectContaining({ id: "call-second" }),
        isError: true,
        executionStarted: false,
        result: expect.objectContaining({
          details: { status: "skipped", deniedReason: "steering" },
        }),
      }),
      expect.any(AbortSignal),
    );
    const skippedOutcome = afterToolOutcome.mock.calls.find(
      ([outcome]) => outcome.toolCall.id === "call-second",
    )?.[0];
    expect(skippedOutcome).not.toHaveProperty("errorKind");
    expect(
      events
        .filter((event) => event.type === "tool_execution_start")
        .map((event) => event.toolCallId),
    ).toEqual(["call-first", "call-second"]);
    expect(
      events
        .filter((event) => event.type === "tool_execution_end")
        .map((event) => ({ id: event.toolCallId, started: event.executionStarted })),
    ).toEqual([
      { id: "call-first", started: true },
      { id: "call-second", started: false },
    ]);
    const skippedEnd = events.find(
      (event) => event.type === "tool_execution_end" && event.toolCallId === "call-second",
    );
    expect(skippedEnd).toMatchObject({
      result: { details: { status: "skipped", deniedReason: "steering" } },
    });
    expect(skippedEnd).not.toHaveProperty("errorKind");
  });

  it("restores drained steering in order when turn_end aborts before injection", async () => {
    const firstReleased = createDeferred();
    const firstStarted = createDeferred();
    const secondExecute = vi.fn(async () => ({ content: [], details: {} }));
    const requestMessages: Message[][] = [];
    const agent = new Agent({
      initialState: {
        model,
        tools: [
          {
            ...makeTool("first"),
            execute: async () => {
              firstStarted.resolve();
              await firstReleased.promise;
              return { content: [{ type: "text", text: "first result" }], details: {} };
            },
          },
          { ...makeTool("second"), execute: secondExecute },
        ],
      },
      streamFn: createTurnSequenceStream(
        [
          [makeCall("first", "call-first"), makeCall("second", "call-second")],
          [{ type: "text", text: "handled steering" }],
        ],
        requestMessages,
      ),
      steeringMode: "all",
      toolExecution: "sequential",
    });
    agent.subscribe((event) => {
      if (event.type === "turn_end" && event.toolResults.length > 0) {
        agent.abort();
      }
    });
    const firstSteer = { role: "user" as const, content: "first steer", timestamp: 2 };
    const secondSteer = { role: "user" as const, content: "second steer", timestamp: 3 };

    const run = agent.prompt("start");
    await firstStarted.promise;
    agent.steer(firstSteer);
    agent.steer(secondSteer);
    firstReleased.resolve();
    await run;

    expect(secondExecute).not.toHaveBeenCalled();
    expect(agent.state.messages).not.toContain(firstSteer);
    expect(agent.state.messages).not.toContain(secondSteer);
    expect(agent.hasQueuedMessages()).toBe(true);

    await agent.prompt("again");

    expect(requestMessages).toHaveLength(2);
    expect(requestMessages[1]?.slice(-2)).toEqual([firstSteer, secondSteer]);
    expect(agent.hasQueuedMessages()).toBe(false);
  });

  it("cancels a drained steering message and permits an explicit re-enqueue", async () => {
    const turnStarted = createDeferred();
    const releaseTurn = createDeferred();
    const requestMessages: Message[][] = [];
    const agent = new Agent({
      initialState: {
        model,
        messages: [makeAssistantMessage([{ type: "text", text: "ready" }])],
      },
      streamFn: createTurnSequenceStream(
        [[{ type: "text", text: "re-enqueued response" }]],
        requestMessages,
      ),
    });
    const target = { role: "user" as const, content: "cancel after drain", timestamp: 2 };
    agent.steer(target);
    agent.subscribe(async (event) => {
      if (event.type === "turn_start") {
        turnStarted.resolve();
        await releaseTurn.promise;
      }
    });

    const run = agent.continue();
    await turnStarted.promise;
    expect(agent.cancelSteeringMessage((message) => message === target)).toBe(target);
    releaseTurn.resolve();
    await run;

    expect(requestMessages).toHaveLength(0);
    expect(agent.state.messages).not.toContain(target);
    expect(agent.hasQueuedMessages()).toBe(false);

    agent.steer(target);
    await agent.continue();

    expect(requestMessages).toHaveLength(1);
    expect(requestMessages[0]?.at(-1)).toBe(target);
    expect(agent.state.messages).toContain(target);
  });

  it("restores drained follow-ups to their deferred queue in order", async () => {
    const requestMessages: Message[][] = [];
    const agent = new Agent({
      initialState: {
        model,
        messages: [makeAssistantMessage([{ type: "text", text: "ready" }])],
      },
      streamFn: createTurnSequenceStream(
        [
          [{ type: "text", text: "new prompt response" }],
          [{ type: "text", text: "follow-up response" }],
        ],
        requestMessages,
      ),
      followUpMode: "all",
    });
    const firstFollowUp = { role: "user" as const, content: "first follow-up", timestamp: 2 };
    const secondFollowUp = { role: "user" as const, content: "second follow-up", timestamp: 3 };
    agent.followUp(firstFollowUp);
    agent.followUp(secondFollowUp);
    let abortBeforeInjection = true;
    agent.subscribe((event) => {
      if (event.type !== "agent_start" || !abortBeforeInjection) {
        return;
      }
      abortBeforeInjection = false;
      const error = new Error("abort before queued prompt injection");
      agent.abort(error);
      throw error;
    });

    await agent.continue();

    expect(requestMessages).toHaveLength(0);
    expect(agent.hasQueuedMessages()).toBe(true);

    await agent.prompt("again");

    expect(requestMessages).toHaveLength(2);
    expect(requestMessages[0]).not.toContain(firstFollowUp);
    expect(requestMessages[0]).not.toContain(secondFollowUp);
    expect(requestMessages[1]?.slice(-2)).toEqual([firstFollowUp, secondFollowUp]);
    expect(agent.hasQueuedMessages()).toBe(false);
  });

  it("suppresses a tool when steering arrives during private execution preflight", async () => {
    const preflightStarted = createDeferred();
    const releasePreflight = createDeferred();
    const execute = vi.fn(async () => ({ content: [], details: { executed: true } }));
    const dispose = vi.fn();
    const tool = attachInternalToolExecutionPreparer(
      { ...makeTool("delayed"), execute },
      async () => {
        preflightStarted.resolve();
        await releasePreflight.promise;
        const finalArgs = { rewritten: true };
        return {
          kind: "ready",
          args: finalArgs,
          execute: async (onImplementationStart) => {
            onImplementationStart?.();
            return await execute();
          },
          dispose,
        };
      },
    );
    const requestMessages: Message[][] = [];
    const afterToolOutcome = vi.fn(async () => undefined);
    const commitReadyCalls = vi.fn();
    const releaseSkippedCalls = vi.fn();
    const agent = new Agent({
      initialState: { model, tools: [tool] },
      streamFn: createTurnSequenceStream(
        [[makeCall("delayed", "delayed-call")], [{ type: "text", text: "redirected" }]],
        requestMessages,
      ),
      toolExecution: "sequential",
      afterToolOutcome,
    });
    setInternalBeforeToolBatch(agent, async () =>
      attachInternalToolBatchLifecycle({}, { commitReadyCalls, releaseSkippedCalls }),
    );
    const steer = { role: "user" as const, content: "redirect", timestamp: 2 };

    const run = agent.prompt("start");
    await preflightStarted.promise;
    agent.steer(steer);
    releasePreflight.resolve();
    await run;

    expect(execute).not.toHaveBeenCalled();
    expect(commitReadyCalls).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(requestMessages[1]?.slice(-3)).toMatchObject([
      { role: "assistant", stopReason: "toolUse" },
      {
        role: "toolResult",
        toolCallId: "delayed-call",
        isError: true,
        details: { status: "skipped", deniedReason: "steering" },
      },
      steer,
    ]);
    expect(afterToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCall: expect.objectContaining({ id: "delayed-call" }),
        args: { rewritten: true },
        executionStarted: false,
      }),
      expect.any(AbortSignal),
    );
  });

  it.each(["parallel"] as const)(
    "uses private final args for %s launch facts and hooks",
    async (toolExecution) => {
      const finalArgs = { rewritten: true };
      const execute = vi.fn(async () => ({ content: [], details: { executed: true } }));
      const tool = attachInternalToolExecutionPreparer(
        { ...makeTool("rewritten"), execute },
        async () => ({
          kind: "ready",
          args: finalArgs,
          execute: async (start) => {
            start?.();
            return await execute();
          },
          dispose: vi.fn(),
        }),
      );
      const afterToolCall = vi.fn(async () => undefined);
      const afterToolOutcome = vi.fn(async () => undefined);
      const commitReadyCalls = vi.fn();
      const agent = new Agent({
        initialState: { model, tools: [tool] },
        streamFn: createTurnSequenceStream(
          [[makeCall("rewritten", "rewritten-call")], [{ type: "text", text: "done" }]],
          [],
        ),
        toolExecution,
        afterToolCall,
        afterToolOutcome,
      });
      setInternalBeforeToolBatch(agent, async () =>
        attachInternalToolBatchLifecycle(
          {},
          {
            commitReadyCalls,
            releaseSkippedCalls: vi.fn(),
          },
        ),
      );

      await agent.prompt("start");

      expect(commitReadyCalls).toHaveBeenCalledExactlyOnceWith([
        { toolCallId: "rewritten-call", args: finalArgs },
      ]);
      expect(afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ args: finalArgs }),
        expect.any(AbortSignal),
      );
      expect(afterToolOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ args: finalArgs, executionStarted: true }),
        expect.any(AbortSignal),
      );
      expect(execute).toHaveBeenCalledOnce();
      expect(
        agent.state.messages.find(
          (message) => message.role === "assistant" && message.stopReason === "toolUse",
        ),
      ).toMatchObject({
        content: [expect.objectContaining({ id: "rewritten-call", arguments: {} })],
      });
    },
  );

  it("disposes private preflight when the steering checkpoint throws", async () => {
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const dispose = vi.fn();
    const tool = attachInternalToolExecutionPreparer(
      { ...makeTool("cleanup"), execute },
      async ({ args }) => ({
        kind: "ready",
        args,
        execute: async (onImplementationStart) => {
          onImplementationStart?.();
          return await execute();
        },
        dispose,
      }),
    );
    const getSteeringMessages = vi
      .fn<() => Promise<AgentMessage[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("steering checkpoint failed"));

    await expect(
      runAgentLoop(
        [{ role: "user", content: "start", timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [tool] },
        { ...config, toolExecution: "sequential", getSteeringMessages },
        () => {},
        undefined,
        createTurnSequenceStream([[makeCall("cleanup", "cleanup-call")]], []),
      ),
    ).rejects.toThrow("steering checkpoint failed");
    expect(execute).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("delivers async steering between tools before shouldStopAfterTurn", async () => {
    const steer = { role: "user" as const, content: "keep going", timestamp: 2 };
    const queued: AgentMessage[] = [];
    const secondExecute = vi.fn(async () => ({ content: [], details: {} }));
    const requestMessages: Message[][] = [];
    const streamFn = createTurnSequenceStream(
      [
        [makeCall("first", "stop-first"), makeCall("second", "stop-second")],
        [{ type: "text", text: "continued" }],
      ],
      requestMessages,
    );
    const shouldStopAfterTurn = vi.fn(() => true);

    const getSteeringMessages = vi.fn(async function (this: { queuedSteering: AgentMessage[] }) {
      return this.queuedSteering.splice(0, 1);
    });
    const steeringConfig = {
      ...config,
      toolExecution: "sequential",
      queuedSteering: queued,
      getSteeringMessages,
      shouldStopAfterTurn,
    } satisfies AgentLoopConfig & { queuedSteering: AgentMessage[] };
    await runAgentLoop(
      [{ role: "user", content: "start", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [
          {
            ...makeTool("first"),
            execute: async () => {
              queued.push(steer);
              return { content: [{ type: "text", text: "first result" }], details: {} };
            },
          },
          { ...makeTool("second"), execute: secondExecute },
        ],
      },
      steeringConfig,
      () => {},
      undefined,
      streamFn,
    );

    expect(requestMessages).toHaveLength(2);
    expect(requestMessages[1]?.at(-1)).toBe(steer);
    expect(secondExecute).not.toHaveBeenCalled();
    expect(shouldStopAfterTurn).toHaveBeenCalledOnce();
    expect(getSteeringMessages).toHaveBeenCalled();
  });

  it("commits drained steering and settled tools before a host-requested model-step stop", async () => {
    const steer = { role: "user" as const, content: "verify the new version", timestamp: 2 };
    const queued: AgentMessage[] = [];
    const requestMessages: Message[][] = [];
    const execute = vi.fn(async () => {
      queued.push(steer);
      return { content: [{ type: "text" as const, text: "reload committed" }], details: {} };
    });
    let refresh = false;
    const context: AgentContext = {
      systemPrompt: "",
      messages: [],
      tools: [{ ...makeTool("reload"), execute }],
    };
    const events: AgentEvent[] = [];
    const result = await runAgentLoop(
      [{ role: "user", content: "edit and reload", timestamp: 1 }],
      context,
      {
        ...config,
        getSteeringMessages: async () => queued.splice(0),
        afterToolCall: async () => {
          refresh = true;
        },
        prepareNextTurn: async () => (refresh ? { stop: true } : undefined),
      },
      (event) => {
        events.push(event);
      },
      undefined,
      createTurnSequenceStream(
        [
          [makeCall("reload", "reload-once")],
          [{ type: "text", text: "must not run on the old catalog" }],
        ],
        requestMessages,
      ),
    );

    expect(requestMessages).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(result.at(-1)).toBe(steer);
    expect(result).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "reload-once",
        content: [{ type: "text", text: "reload committed" }],
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: "agent_end", messages: result });
    expect(
      events.filter((event) => event.type === "message_end" && event.message === steer),
    ).toHaveLength(1);
    expect(queued).toEqual([]);
  });

  it("delivers steering admitted while the final follow-up drain is pending", async () => {
    const followUpDrainStarted = createDeferred();
    const releaseFollowUpDrain = createDeferred();
    const steer = { role: "user" as const, content: "one more thing", timestamp: 2 };
    const queued: AgentMessage[] = [];
    const requestMessages: Message[][] = [];
    const run = runAgentLoop(
      [{ role: "user", content: "start", timestamp: 1 }],
      { systemPrompt: "", messages: [] },
      {
        ...config,
        getSteeringMessages: async () => queued.splice(0, 1),
        getFollowUpMessages: async () => {
          followUpDrainStarted.resolve();
          await releaseFollowUpDrain.promise;
          return [];
        },
      },
      () => {},
      undefined,
      createTurnSequenceStream(
        [[{ type: "text", text: "initial response" }], [{ type: "text", text: "steer response" }]],
        requestMessages,
      ),
    );

    await followUpDrainStarted.promise;
    queued.push(steer);
    releaseFollowUpDrain.resolve();
    await run;

    expect(requestMessages).toHaveLength(2);
    expect(requestMessages[1]?.at(-1)).toBe(steer);
    expect(queued).toEqual([]);
  });

  it("releases only admitted sequential calls when steering suppresses a mixed tail", async () => {
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const requestMessages: Message[][] = [];
    const streamFn = createTurnSequenceStream(
      [
        [makeCall("required", "invalid-tail"), makeCall("valid", "valid-tail")],
        [{ type: "text", text: "steer handled" }],
      ],
      requestMessages,
    );
    const agent = new Agent({
      initialState: {
        model,
        tools: [
          {
            name: "required",
            label: "required",
            description: "requires input",
            parameters: Type.Object({ value: Type.String() }),
            execute,
          },
          { ...makeTool("valid"), execute },
        ],
      },
      streamFn,
      toolExecution: "sequential",
    });
    const commitReadyCalls = vi.fn();
    const releaseSkippedCalls = vi.fn();
    setInternalBeforeToolBatch(agent, async ({ calls }) => {
      expect(calls.map((call) => call.toolCall.id)).toEqual(["invalid-tail", "valid-tail"]);
      return attachInternalToolBatchLifecycle({}, { commitReadyCalls, releaseSkippedCalls });
    });
    agent.subscribe(async (event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "toolUse"
      ) {
        await Promise.resolve();
        agent.steer({ role: "user", content: "redirect", timestamp: 2 });
      }
    });

    await agent.prompt("start");

    expect(requestMessages[1]?.slice(-4)).toMatchObject([
      { role: "assistant", stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "invalid-tail", isError: true },
      { role: "toolResult", toolCallId: "valid-tail", isError: true },
      { role: "user", content: "redirect" },
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(commitReadyCalls).not.toHaveBeenCalled();
    expect(releaseSkippedCalls).toHaveBeenCalledExactlyOnceWith(["invalid-tail", "valid-tail"]);
  });

  it("checks steering once before launching a prepared parallel batch", async () => {
    const preparationReleased = createDeferred();
    const preparationBlocked = createDeferred();
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const requestMessages: Message[][] = [];
    const streamFn = createTurnSequenceStream(
      [
        [makeCall("required", "invalid"), makeCall("parallel", "prepared")],
        [{ type: "text", text: "steer handled" }],
      ],
      requestMessages,
    );
    const agent = new Agent({
      initialState: {
        model,
        tools: [
          {
            name: "required",
            label: "required",
            description: "requires input",
            parameters: Type.Object({ value: Type.String() }),
            execute,
          },
          { ...makeTool("parallel"), execute },
        ],
      },
      streamFn,
      toolExecution: "parallel",
      beforeToolCall: async ({ toolCall }) => {
        if (toolCall.id === "prepared") {
          preparationBlocked.resolve();
          await preparationReleased.promise;
        }
        return undefined;
      },
    });
    const commitReadyCalls = vi.fn();
    const releaseSkippedCalls = vi.fn();
    setInternalBeforeToolBatch(agent, async ({ calls }) => {
      expect(calls.map((call) => call.toolCall.id)).toEqual(["invalid", "prepared"]);
      return attachInternalToolBatchLifecycle({}, { commitReadyCalls, releaseSkippedCalls });
    });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
      events.push(event);
    });
    const steer = { role: "user" as const, content: "before launch", timestamp: 2 };

    const run = agent.prompt("start");
    await preparationBlocked.promise;
    agent.steer(steer);
    preparationReleased.resolve();
    await run;

    expect(execute).not.toHaveBeenCalled();
    expect(commitReadyCalls).not.toHaveBeenCalled();
    expect(releaseSkippedCalls).toHaveBeenCalledExactlyOnceWith(["invalid", "prepared"]);
    expect(requestMessages[1]?.slice(-4)).toMatchObject([
      { role: "assistant", stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "invalid", isError: true },
      {
        role: "toolResult",
        toolCallId: "prepared",
        isError: true,
        content: [{ type: "text", text: "Skipped to process an incoming message." }],
        details: { status: "skipped", deniedReason: "steering" },
      },
      steer,
    ]);
    expect(
      events
        .filter((event) => event.type === "tool_execution_end")
        .map((event) => ({ id: event.toolCallId, kind: event.errorKind })),
    ).toEqual([
      { id: "invalid", kind: "argument-validation" },
      { id: "prepared", kind: undefined },
    ]);
  });

  it.each(["sequential", "parallel"] as const)(
    "pairs every tool lifecycle before rejecting a %s admission commit failure",
    async (toolExecution) => {
      const firstExecute = vi.fn(async () => ({ content: [], details: { executed: "first" } }));
      const secondExecute = vi.fn(async () => ({ content: [], details: { executed: "second" } }));
      const thirdExecute = vi.fn(async () => ({ content: [], details: { executed: "third" } }));
      const commitError = new Error("private admission details must not reach tool results");
      const releaseSkippedCalls = vi.fn();
      const afterToolOutcome = vi.fn(async () => undefined);
      const events: AgentEvent[] = [];

      await expect(
        runAgentLoop(
          [{ role: "user", content: "run", timestamp: 1 }],
          {
            systemPrompt: "",
            messages: [],
            tools: [
              { ...makeTool("first"), execute: firstExecute },
              { ...makeTool("second"), execute: secondExecute },
              { ...makeTool("third"), execute: thirdExecute },
            ],
          },
          {
            ...config,
            toolExecution,
            afterToolOutcome,
            beforeToolBatch: async () =>
              attachInternalToolBatchLifecycle(
                {},
                {
                  commitReadyCalls: (calls) => {
                    if (calls.some((call) => call.toolCallId === "commit-second")) {
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
          createTurnSequenceStream([
            [
              makeCall("first", "commit-first"),
              makeCall("second", "commit-second"),
              makeCall("third", "commit-third"),
            ],
          ]),
        ),
      ).rejects.toBe(commitError);

      expect(firstExecute).toHaveBeenCalledOnce();
      expect(secondExecute).not.toHaveBeenCalled();
      expect(thirdExecute).not.toHaveBeenCalled();
      expect(releaseSkippedCalls).toHaveBeenCalledExactlyOnceWith([
        "commit-second",
        "commit-third",
      ]);
      expect(
        events
          .filter((event) => event.type === "tool_execution_start")
          .map((event) => event.toolCallId),
      ).toEqual(["commit-first", "commit-second", "commit-third"]);
      const toolEnds = events
        .filter((event) => event.type === "tool_execution_end")
        .map((event) => ({ id: event.toolCallId, started: event.executionStarted }));
      expect(toolEnds).toHaveLength(3);
      expect(toolEnds).toEqual(
        expect.arrayContaining([
          { id: "commit-first", started: true },
          { id: "commit-second", started: false },
          { id: "commit-third", started: false },
        ]),
      );
      const toolResults = events
        .filter(
          (
            event,
          ): event is Extract<AgentEvent, { type: "message_end" }> & {
            message: { role: "toolResult" };
          } => event.type === "message_end" && event.message.role === "toolResult",
        )
        .map((event) => event.message);
      expect(toolResults.map((message) => message.toolCallId)).toEqual([
        "commit-first",
        "commit-second",
        "commit-third",
      ]);
      for (const toolResult of toolResults.slice(1)) {
        expect(toolResult).toMatchObject({
          isError: true,
          content: [{ type: "text", text: "Tool execution was blocked before launch." }],
          details: { status: "blocked", deniedReason: "tool-admission" },
        });
        expect(JSON.stringify(toolResult)).not.toContain(commitError.message);
      }
      expect(afterToolOutcome).toHaveBeenCalledTimes(3);
      for (const toolCallId of ["commit-second", "commit-third"]) {
        expect(afterToolOutcome).toHaveBeenCalledWith(
          expect.objectContaining({
            executionStarted: false,
            toolCall: expect.objectContaining({ id: toolCallId }),
          }),
          undefined,
        );
      }
      expect(events.filter((event) => event.type === "turn_end")).toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ role: "assistant", stopReason: "toolUse" }),
          toolResults,
        }),
      ]);
    },
  );

  it("keeps Agent active until started parallel work settles after a later commit failure", async () => {
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const secondCommitAttempted = createDeferred();
    const secondExecute = vi.fn(async () => ({ content: [], details: {} }));
    const commitError = new Error("admission commit failed");
    const releaseSkippedCalls = vi.fn();
    const events: AgentEvent[] = [];
    let providerCalls = 0;
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
      streamFn: createTurnSequenceStream(
        [[makeCall("first", "idle-first"), makeCall("second", "idle-second")]],
        [],
        () => {
          providerCalls += 1;
        },
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

    expect(providerCalls).toBe(1);
    expect(secondExecute).not.toHaveBeenCalled();
    expect(releaseSkippedCalls).toHaveBeenCalledWith(["idle-second"]);
    expect(agent.state.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "assistant",
    ]);
    const toolUseTurnEnd = events.findIndex(
      (event) =>
        event.type === "turn_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "toolUse",
    );
    const failureTurnEnd = events.findIndex(
      (event) =>
        event.type === "turn_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "error",
    );
    const agentEnd = events.findIndex((event) => event.type === "agent_end");
    expect(toolUseTurnEnd).toBeGreaterThanOrEqual(0);
    expect(failureTurnEnd).toBeGreaterThan(toolUseTurnEnd);
    expect(agentEnd).toBeGreaterThan(failureTurnEnd);
    expect(events.slice(agentEnd + 1)).toEqual([]);
  });

  it.each(["parallel"] as const)(
    "delivers loop warnings after raw outcome hooks in %s batches",
    async (toolExecution) => {
      const executed: string[] = [];
      const requestMessages: Message[][] = [];
      const rawOutcomes: AgentToolResult<unknown>[] = [];
      const streamFn = createTurnSequenceStream(
        [
          [makeCall("read", "warned"), makeCall("list", "sibling")],
          [makeCall("read", "next")],
          [{ type: "text", text: "done" }],
        ],
        requestMessages,
      );
      const events = await collectEvents(
        captureTools(
          [makeTool("read", executed), makeTool("list", executed)],
          streamFn,
          {
            toolExecution,
            beforeToolBatch: async ({ calls }) => ({
              warnings: calls
                .filter(({ toolCall }) => toolCall.id === "warned")
                .map(({ toolCall }) => ({
                  kind: "tool-loop-warning" as const,
                  toolCallId: toolCall.id,
                  count: 10,
                })),
            }),
            afterToolCall: async ({ result }) => {
              rawOutcomes.push(result);
            },
            afterToolOutcome: async ({ result }) => {
              rawOutcomes.push(result);
              return { content: [...result.content, { type: "text", text: "outcome hook" }] };
            },
          },
          undefined,
        ),
      );
      expect(rawOutcomes.every((result) => result.content.length === 1)).toBe(true);
      const results = requestMessages.at(-1)?.filter((message) => message.role === "toolResult");
      expect(results?.map((message) => message.content)).toEqual([
        [
          { type: "text", text: "read result" },
          { type: "text", text: "outcome hook" },
          {
            type: "text",
            text: "[System note: Tool-loop warning after 10 repeated calls. Change your approach or stop if you are not making progress.]",
          },
        ],
        [
          { type: "text", text: "list result" },
          { type: "text", text: "outcome hook" },
        ],
        [
          { type: "text", text: "read result" },
          { type: "text", text: "outcome hook" },
        ],
      ]);
      expect(
        events.filter((event) => event.type === "tool_execution_end").map((event) => event.result),
      ).toEqual(results?.map((message) => expect.objectContaining({ content: message.content })));
      expect(executed).toEqual(["read", "list", "read"]);
    },
  );

  it("honors outcome-hook termination during the first recovery turn", async () => {
    const executed: string[] = [];
    let streamCalls = 0;
    const streamFn = createTurnSequenceStream([[makeCall("read", "loop-1")]], [], () => {
      streamCalls += 1;
      if (streamCalls > 1) {
        throw new Error("model was called after outcome-hook termination");
      }
    });
    const events = await collectEvents(
      captureTools(
        [makeTool("read", executed)],
        streamFn,
        {
          beforeToolBatch: async ({ calls }) => {
            const first = calls[0];
            return first ? { intervention: criticalLoopFor(first.toolCall) } : undefined;
          },
          afterToolOutcome: async () => ({ terminate: true }),
        },
        undefined,
      ),
    );

    expect(streamCalls).toBe(1);
    expect(executed).toEqual([]);
    // The run ends normally after the terminated batch: no forced
    // tool-loop-recovery failure message, which is reserved for later loops.
    expect(events.at(-1)).toMatchObject({ type: "agent_end" });
    expect(
      events.find(
        (
          event,
        ): event is Extract<AgentEvent, { type: "message_end" }> & {
          message: { role: "assistant" };
        } =>
          event.type === "message_end" &&
          event.message.role === "assistant" &&
          event.message.stopReason === "error",
      ),
    ).toBeUndefined();
  });

  it("stops pre-admission validation after cancellation and aborts the untouched tail", async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const resolverCalls: string[] = [];
    let streamCalls = 0;
    const streamFn = createTurnSequenceStream(
      [
        [
          makeCall("d_first_tool", "d-first"),
          makeCall("d_second_tool", "d-second"),
          makeCall("d_third_tool", "d-third"),
        ],
      ],
      [],
      () => {
        streamCalls += 1;
        if (streamCalls > 1) {
          throw new Error("model was called after abort");
        }
      },
    );
    const deferredTool = (name: string): AgentTool => ({
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
    });
    const events = await collectEvents(
      captureTools(
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
            return deferredTool(toolCall.name);
          },
          beforeToolBatch: async () => undefined,
        },
        controller.signal,
      ),
    );

    expect(streamCalls).toBe(1);
    expect(resolverCalls).toEqual(["d_first_tool"]);
    expect(executed).toEqual([]);
    const toolResults = events
      .filter(
        (
          event,
        ): event is Extract<AgentEvent, { type: "message_end" }> & {
          message: { role: "toolResult" };
        } => event.type === "message_end" && event.message.role === "toolResult",
      )
      .map((event) => event.message);
    expect(toolResults).toHaveLength(3);
    for (const toolResult of toolResults) {
      expect(toolResult).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "Operation aborted" }],
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
    const events = await collectEvents(
      captureTools(
        [
          { ...makeTool("read", executed), resultContentSource: "network" },
          makeTool("list", executed),
        ],
        streamFn,
        {
          beforeToolBatch: async ({ calls }) => {
            const repeated = calls.find((call) => call.toolCall.name === "read");
            return repeated ? { intervention: criticalLoopFor(repeated.toolCall) } : undefined;
          },
        },
        undefined,
      ),
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
    const toolEnds = events.filter((event) => event.type === "tool_execution_end");
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
        content: [
          {
            type: "text",
            text: expect.stringContaining("tool-loop recovery encountered another critical loop"),
          },
        ],
      },
    });
  });

  it("preserves the recovery budget across continue retries and resets it for a new prompt", async () => {
    let phase: "initial" | "retry" | "new-prompt" = "initial";
    let phaseCalls = 0;
    const streamFn: StreamFn = () => {
      phaseCalls += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          phase === "initial" && phaseCalls === 2
            ? {
                ...makeAssistantMessage([]),
                stopReason: "error" as const,
                errorMessage: "retryable provider failure",
              }
            : phase === "new-prompt" && phaseCalls === 2
              ? makeAssistantMessage([{ type: "text", text: "recovered on the new run" }])
              : makeAssistantMessage([
                  {
                    type: "toolCall",
                    id: `${phase}-${phaseCalls}`,
                    name: "read",
                    arguments: {},
                  },
                ]);
        if (message.stopReason === "error") {
          stream.push({ type: "error", reason: "error", error: message });
        } else {
          stream.push({
            type: "done",
            reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
            message,
          });
        }
        stream.end();
      });
      return stream;
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
      content: [
        {
          type: "text",
          text: expect.stringContaining("tool-loop recovery encountered another critical loop"),
        },
      ],
    });

    phase = "new-prompt";
    phaseCalls = 0;
    await agent.prompt("new run");

    expect(phaseCalls).toBe(2);
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "recovered on the new run" }],
    });
  });

  it.each([{ source: "network" as const, tainted: true }])(
    "persists $source tool-result taint through the assistant turn",
    async ({ source, tainted }) => {
      const tool: AgentTool = {
        ...makeTool("fetch"),
        ...(source ? { resultContentSource: source } : {}),
      };
      const streamFn = createTurnSequenceStream([
        [{ type: "toolCall", id: "call-fetch", name: tool.name, arguments: {} }],
        [{ type: "text", text: "stored result" }],
      ]);

      const run = captureTools([tool], streamFn, {}, undefined);
      await collectEvents(run);
      const messages = await run.result;
      const toolResult = messages.find((message) => message.role === "toolResult");
      const assistant = messages.findLast(
        (message): message is AssistantMessage => message.role === "assistant",
      );
      const metadata = (message: AgentMessage | undefined) =>
        message ? (message as unknown as Record<string, unknown>)["__openclaw"] : undefined;

      expect(metadata(toolResult)).toEqual(
        tainted ? { resultContentSource: "network" } : undefined,
      );
      expect(metadata(assistant)).toEqual(tainted ? { turnTainted: true } : undefined);
    },
  );

  it.each(["execute", "prepare", "immediate", "after-call"] as const)(
    "preserves only operation-owned error provenance at %s",
    async (phase) => {
      const provenance = { source: "operation-effect-proof" };
      const failure = attachInternalToolResultProvenance(
        new Error("operation rejected"),
        provenance,
      );
      const tool: AgentTool = {
        ...makeTool("operation"),
        execute: async () => {
          if (phase === "execute") {
            throw failure;
          }
          return { content: [{ type: "text", text: "completed" }], details: {} };
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
      const run = captureTools(
        [tool],
        createTurnSequenceStream([
          [{ type: "toolCall", id: "operation-call", name: tool.name, arguments: {} }],
          [{ type: "text", text: "recovered" }],
        ]),
        phase === "after-call"
          ? {
              afterToolCall: async () => {
                throw failure;
              },
            }
          : {},
        undefined,
      );
      const events = await collectEvents(run);
      const end = events.find((event) => event.type === "tool_execution_end");
      if (
        end?.type !== "tool_execution_end" ||
        typeof end.result !== "object" ||
        end.result === null
      ) {
        throw new Error("Expected the operation's terminal result");
      }
      expect(end.isError).toBe(true);
      expect(getInternalToolResultProvenance(end.result)).toBe(
        phase === "after-call" ? undefined : provenance,
      );
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
              content: [{ type: "text", text: "committed" }],
              details: { phase: "execute" },
              extra,
            },
            acknowledge,
          ),
          provenance,
        ),
    };
    const streamFn = createTurnSequenceStream([
      [{ type: "toolCall", id: "commit-probe", name: tool.name, arguments: {} }],
      [{ type: "text", text: "done" }],
    ]);
    const run = runAgentLoop(
      [{ role: "user", content: "commit", timestamp: 1 }],
      { systemPrompt: "", messages: [], tools: [tool] },
      {
        ...config,
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
              { type: "text", text: "committed" },
              { type: "text", text: expect.stringContaining("Tool-loop warning after 10") },
            ],
          });
          if (typeof event.result === "object" && event.result !== null) {
            expect(getInternalToolResultProvenance(event.result)).toBe(provenance);
          }
        }
        if (
          !testCase.failAttachment &&
          event.type === "message_end" &&
          event.message.role === "toolResult"
        ) {
          expect(getInternalToolResultProvenance(event.message)).toBe(provenance);
          acknowledgeInternalToolResult(event.message);
        }
        if (
          testCase.failAttachment &&
          event.type === "message_end" &&
          event.message.role === "toolResult"
        ) {
          throw new Error("attachment failed");
        }
      },
      undefined,
      streamFn,
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
    ["sequential", "invalid arguments"],
    ["parallel", "policy blocked"],
  ] as const)(
    "never stamps external provenance on %s %s calls that did not execute",
    async (toolExecution, failure) => {
      const executed: string[] = [];
      const tool: AgentTool = {
        ...makeTool("network_probe", executed),
        resultContentSource: "network",
        ...(failure === "invalid arguments"
          ? { parameters: Type.Object({ query: Type.String() }) }
          : {}),
      };
      const streamFn = createTurnSequenceStream([
        [{ type: "toolCall", id: "network-preflight", name: tool.name, arguments: {} }],
        [{ type: "text", text: "local outcome" }],
      ]);
      const run = captureTools(
        [tool],
        streamFn,
        {
          toolExecution,
          ...(failure === "policy blocked"
            ? { beforeToolCall: async () => ({ block: true, reason: "local policy" }) }
            : {}),
        },
        undefined,
      );

      const events = await collectEvents(run);
      const messages = await run.result;
      const toolResult = messages.find((message) => message.role === "toolResult");
      const assistant = messages.findLast((message) => message.role === "assistant");

      expect(executed).toEqual([]);
      expect(events).toContainEqual(
        expect.objectContaining({ type: "tool_execution_end", executionStarted: false }),
      );
      expect((toolResult as unknown as { __openclaw?: unknown })?.["__openclaw"]).toBeUndefined();
      expect((assistant as unknown as { __openclaw?: unknown })?.["__openclaw"]).toBeUndefined();
    },
  );

  it.each([
    ["sequential", "caller cancellation", false],
    ["parallel", "remote failure after cancellation", true],
  ] as const)(
    "preserves %s provenance for %s after execution begins",
    async (toolExecution, failure, tainted) => {
      const controller = new AbortController();
      const cancelReason = new Error("operator cancelled");
      const afterToolCall = vi.fn(async () => undefined);
      const tool: AgentTool = {
        ...makeTool("network_cancel"),
        resultContentSource: "network",
        execute: async () => {
          controller.abort(cancelReason);
          throw tainted ? new Error("remote failure after cancellation") : cancelReason;
        },
      };
      const streamFn = createTurnSequenceStream([
        [{ type: "toolCall", id: "network-cancel", name: tool.name, arguments: {} }],
      ]);
      const run = captureTools(
        [tool],
        streamFn,
        { toolExecution, afterToolCall },
        controller.signal,
      );

      const events = await collectEvents(run);
      const messages = await run.result;
      const toolResult = messages.find((message) => message.role === "toolResult");

      expect(afterToolCall).toHaveBeenCalledOnce();
      expect(events).toContainEqual(
        expect.objectContaining({ type: "tool_execution_end", executionStarted: true }),
      );
      expect((toolResult as unknown as { __openclaw?: unknown })?.["__openclaw"]).toEqual(
        tainted ? { resultContentSource: "network" } : undefined,
      );
    },
  );

  it("ignores progress updates after a tool execution settles", async () => {
    let delayedUpdate: ((result: AgentToolResult<unknown>) => void) | undefined;
    const tool: AgentTool = {
      name: "delayed_tool",
      label: "delayed_tool",
      description: "captures progress callbacks",
      parameters: Type.Object({}, { additionalProperties: false }),
      hideFromChannelProgress: true,
      execute: async (_toolCallId, _args, _signal, onUpdate) => {
        delayedUpdate = onUpdate;
        onUpdate?.({
          content: [{ type: "text", text: "running" }],
          details: { status: "running" },
        });
        return {
          content: [{ type: "text", text: "done" }],
          details: { status: "done" },
          terminate: true,
        };
      },
    };
    const streamFn = createTurnSequenceStream([
      [{ type: "toolCall", id: "call-delayed", name: tool.name, arguments: {} }],
    ]);

    const events = await collectEvents(
      captureTools([tool], streamFn, { toolExecution: "sequential" }, undefined),
    );
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
    delayedUpdate?.({
      content: [{ type: "text", text: "late" }],
      details: { status: "late" },
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(events).toHaveLength(countAfterRun);
    expect(events.filter((event) => event.type === "tool_execution_update")).toHaveLength(1);
  });

  it.each([true])("normalizes missing tool content with loop warning=%s", async (warn) => {
    const contexts: Context[] = [];
    const streamFn = createTurnSequenceStream(
      [[makeCall("empty", "call-empty")], [{ type: "text", text: "done" }]],
      [],
      (context) => {
        contexts.push(context);
      },
    );
    const tool: AgentTool = {
      name: "empty",
      label: "empty",
      description: "returns no display content",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => ({ details: { ok: true } }) as AgentToolResult<unknown>,
    };

    await collectEvents(
      captureTools(
        [tool],
        streamFn,
        {
          beforeToolBatch: async () => ({
            warnings: warn
              ? [{ kind: "tool-loop-warning", toolCallId: "call-empty", count: 10 }]
              : [],
          }),
        },
        undefined,
      ),
    );

    expect(contexts).toHaveLength(2);
    expect(contexts[1]?.messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolName: "empty",
        content: warn
          ? [{ type: "text", text: expect.stringContaining("Tool-loop warning after 10") }]
          : [],
      }),
    );
  });

  it("marks argument validation failures with typed provenance", async () => {
    const executed: string[] = [];
    const afterToolOutcome = vi.fn(async () => ({
      details: { observed: "pre-execution" },
    }));
    const streamFn = createTurnSequenceStream([
      [makeCall("edit", "call-edit")],
      [{ type: "text", text: "done" }],
    ]);
    const tool: AgentTool = {
      ...makeTool("edit", executed),
      parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
    };

    const events = await collectEvents(
      captureTools([tool], streamFn, { afterToolOutcome }, undefined),
    );
    const endEvent = events.find((event) => event.type === "tool_execution_end");

    expect(executed).toEqual([]);
    expect(endEvent).toMatchObject({
      executionStarted: false,
      errorKind: "argument-validation",
      result: {
        details: { observed: "pre-execution" },
      },
    });
    expect(afterToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        args: {},
        executionStarted: false,
        errorKind: "argument-validation",
        isError: true,
        toolCall: expect.objectContaining({ name: "edit" }),
      }),
      undefined,
    );
  });

  it("preserves a terminal result when the finalized-outcome hook throws", async () => {
    const executed: string[] = [];
    let turn = 0;
    const streamFn = createTurnSequenceStream(
      [[makeCall("message", "call-message")], [makeCall("exec", "call-exec")]],
      [],
      (_context, currentTurn) => {
        turn = currentTurn;
      },
    );

    const run = captureTools(
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
      undefined,
    );

    const events = await collectEvents(run);

    expect(turn).toBe(1);
    expect(executed).toEqual(["message"]);
    expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(1);
    expect(events.find((event) => event.type === "tool_execution_end")?.result).toMatchObject({
      content: [{ type: "text", text: "finalized hook failed" }],
      terminate: true,
    });
    const terminal = events.find((event) => event.type === "tool_execution_end");
    expect(terminal).toBeDefined();
    if (terminal && typeof terminal.result === "object" && terminal.result !== null) {
      expect(getInternalToolResultProvenance(terminal.result)).toBeUndefined();
    }
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
            return { content: [{ type: "text", text: "first ran" }], details: { aborted: true } };
          },
        },
        ...["second", "third"].map((name) =>
          Object.assign(makeTool(name), { hideFromChannelProgress: true, execute: skippedExecute }),
        ),
      ];
      const requests: Message[][] = [];
      const run = captureTools(
        tools,
        createTurnSequenceStream(
          [[makeCall("first"), makeCall("second"), makeCall("third")]],
          requests,
        ),
        { toolExecution, afterToolOutcome },
        controller.signal,
      );
      const events = await collectEvents(run);
      const messages = await run.result;
      expect(requests).toHaveLength(1);
      expect(skippedExecute).not.toHaveBeenCalled();
      expect(messages.filter((message) => message.role === "toolResult")).toMatchObject([
        { toolCallId: "first", isError: false },
        {
          toolCallId: "second",
          isError: true,
          content: [{ type: "text", text: "Operation aborted" }],
        },
        {
          toolCallId: "third",
          isError: true,
          content: [{ type: "text", text: "Operation aborted" }],
        },
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
          expect(afterToolOutcome).toHaveBeenCalledWith(
            expect.objectContaining({
              toolCall: expect.objectContaining({ id }),
              isError: true,
              executionStarted: false,
            }),
            controller.signal,
          );
        }
      }
      expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(3);
      expect(events.filter((event) => event.type === "tool_execution_end")).toHaveLength(3);
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
    let streamCalls = 0;
    const streamFn = createTurnSequenceStream([[makeCall("yield_tool", "call-yield")]], [], () => {
      streamCalls += 1;
      if (streamCalls > 1) {
        throw new Error("model was called after abort");
      }
    });
    const yieldTool: AgentTool = {
      name: "yield_tool",
      label: "yield_tool",
      description: "Yield the active run as a clean handoff",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        controller.abort({ code: "sessions_yield", turnHandoff: true });
        return {
          content: [{ type: "text", text: "yielded" }],
          details: { yielded: true },
        };
      },
    };

    const messages = await runAgentLoop(
      [{ role: "user", content: "yield during tool", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [yieldTool],
      },
      config,
      () => {},
      controller.signal,
      streamFn,
    );

    expect(streamCalls).toBe(1);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
    expect(messages.some((message) => message.role === "custom")).toBe(false);
  });

  it("does not start prepared parallel tools after the run aborts mid-batch", async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const afterToolCall = vi.fn(async () => undefined);
    const commitReadyCalls = vi.fn();
    const releaseSkippedCalls = vi.fn();
    const streamFn = createTurnSequenceStream([
      [makeCall("paid", "call-paid"), makeCall("gated", "call-gated")],
    ]);
    const events: AgentEvent[] = [];

    const abortedMessages = await runAgentLoop(
      [{ role: "user", content: "abort during parallel tool preparation", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [
          { ...makeTool("paid", executed), resultContentSource: "network" },
          { ...makeTool("gated", executed), resultContentSource: "network" },
        ],
      },
      {
        ...config,
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
      (event) => {
        events.push(event);
      },
      controller.signal,
      streamFn,
    );

    const endEvents = events.filter((event) => event.type === "tool_execution_end");

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
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "paid",
          isError: true,
          executionStarted: false,
          result: expect.objectContaining({
            content: [{ type: "text", text: "Operation aborted" }],
          }),
        }),
        expect.objectContaining({
          toolName: "gated",
          isError: true,
          executionStarted: false,
          result: expect.objectContaining({
            content: [{ type: "text", text: "Operation aborted" }],
          }),
        }),
      ]),
    );
  });

  it("does not request another model turn when an async turn hook aborts the run", async () => {
    const controller = new AbortController();
    let streamCalls = 0;
    const streamFn = createTurnSequenceStream(
      [[makeCall("hook_abort", "call-hook-abort")]],
      [],
      () => {
        streamCalls += 1;
        if (streamCalls > 1) {
          throw new Error("model was called after abort");
        }
      },
    );
    const events: AgentEvent[] = [];

    const messages = await runAgentLoop(
      [{ role: "user", content: "abort from hook", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [makeTool("hook_abort")],
      },
      {
        ...config,
        prepareNextTurn: async () => {
          await Promise.resolve();
          controller.abort(new Error("user aborted"));
          return undefined;
        },
      },
      (event) => {
        events.push(event);
      },
      controller.signal,
      streamFn,
    );

    expect(streamCalls).toBe(1);
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
    expect(events.map((event) => event.type)).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "message_start",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "message_start",
      "message_end",
      "turn_end",
      "turn_start",
      "message_start",
      "message_end",
      "turn_end",
      "message_start",
      "message_end",
      "agent_end",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "agent_end" });
  });
});

describe("Agent next-turn preparation", () => {
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
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const content: AssistantMessage["content"] =
          turn === 1 ? [makeCall("refresh", "call-refresh")] : [{ type: "text", text: "done" }];
        stream.push({
          type: "done",
          reason: turn === 1 ? "toolUse" : "stop",
          message: {
            role: "assistant",
            content,
            api: activeModel.api,
            provider: activeModel.provider,
            model: activeModel.id,
            usage: TEST_USAGE,
            stopReason: turn === 1 ? "toolUse" : "stop",
            timestamp: turn,
          },
        });
        stream.end();
      });
      return stream;
    };
    const tool: AgentTool = {
      name: "refresh",
      label: "refresh",
      description: "refresh turn state",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => ({ content: [{ type: "text", text: "refreshed" }], details: {} }),
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
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
