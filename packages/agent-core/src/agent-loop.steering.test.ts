import { setImmediate } from "node:timers/promises";
import type { StreamOptions, UserMessage } from "@openclaw/llm-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createStreamedSteeringConfig } from "./agent-loop-steering.js";
import {
  config,
  captureToolLoop,
  captureAgent as makeAgent,
  expectedToolResult,
  finishMessageStream,
  startToolCalls,
  createTurnSequenceStream,
  makeAssistantMessage,
  makeCall,
  makeTool,
  model,
  reply,
  user,
} from "./agent-loop.test-support.js";
import { Agent, type AgentOptions } from "./agent.js";
import {
  attachInternalSyncSteeringGetter,
  attachInternalToolBatchLifecycle,
  attachInternalToolExecutionPreparer,
  getInternalToolTurnInputScope,
  setInternalBeforeToolBatch,
  setInternalToolTurnCompletion,
  type InternalToolExecutionPreparation,
} from "./internal-hooks.js";
import { createAssistantMessageEventStream, type AssistantMessage, type Message } from "./llm.js";
import type {
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentToolCall,
  AgentTool,
} from "./types.js";

const text = (value: string) => [{ type: "text" as const, text: value }];
const emptyResult = () => ({ content: [], details: {} });
const done = text("done");

function gate() {
  const started = createDeferred();
  const released = createDeferred();
  return {
    started: started.promise,
    release: () => released.resolve(),
    wait: () => {
      started.resolve();
      return released.promise;
    },
  };
}

function runLoop(
  turns: AssistantMessage["content"][],
  loopConfig: Partial<AgentLoopConfig>,
  tools: AgentTool[] = [],
  prompt = "start",
) {
  const requests: Message[][] = [];
  const { run: result, events } = captureToolLoop({
    tools,
    config: loopConfig,
    prompt: user(prompt),
    streamFn: createTurnSequenceStream(turns, requests),
  });
  return { result, events, requests };
}

function expectInjectedOnce(events: AgentEvent[], message: AgentMessage) {
  expect(
    events.filter((event) => event.type === "message_end" && event.message === message),
  ).toHaveLength(1);
}

function expectHook(hook: unknown, args: object) {
  expect(hook).toHaveBeenCalledWith(expect.objectContaining(args), expect.any(AbortSignal));
}

function trackBatch(agent: Agent) {
  const commitReadyCalls = vi.fn();
  const releaseSkippedCalls = vi.fn();
  setInternalBeforeToolBatch(agent, async () =>
    attachInternalToolBatchLifecycle({}, { commitReadyCalls, releaseSkippedCalls }),
  );
  return { commitReadyCalls, releaseSkippedCalls };
}

function preparedTool(name: string, prepare: (args: unknown) => unknown = (args) => args) {
  const execute = vi.fn(async () => emptyResult());
  const dispose = vi.fn();
  const tool = attachInternalToolExecutionPreparer(
    { ...makeTool(name), execute },
    async ({ args }): Promise<InternalToolExecutionPreparation> => ({
      kind: "ready",
      args: await prepare(args),
      dispose,
      execute: async (start) => {
        start?.();
        return await execute();
      },
    }),
  );
  return { tool, execute, dispose };
}

describe("agentLoop steering", () => {
  it.each(["initial", "steered"] as const)(
    "commits %s input identity before a message_end listener rejects",
    async (mode) => {
      const target = user("Input B needs its own answer.", 2);
      const requestMessages: Message[][] = [];
      const agent = new Agent({
        initialState: { model },
        streamFn: createTurnSequenceStream(
          [
            ...(mode === "steered" ? [[{ type: "text" as const, text: "Input A response" }]] : []),
            [{ type: "text", text: "Input B response" }],
          ],
          requestMessages,
        ),
      });
      const completion = () => false;
      setInternalToolTurnCompletion(agent, completion);
      let beforeCommit: object | undefined;
      let publishedScope: object | undefined;
      let publishedMessage = false;
      let queued = false;
      const publicationError = new Error("input publication failed");
      agent.subscribe((event) => {
        if (mode === "steered" && event.type === "turn_end" && !queued) {
          queued = true;
          agent.steer(target);
        }
        if (event.type === "message_start" && event.message === target) {
          beforeCommit = getInternalToolTurnInputScope(completion);
        }
        if (event.type === "message_end" && event.message === target) {
          publishedMessage = agent.state.messages.includes(target);
          publishedScope = getInternalToolTurnInputScope(completion);
          throw publicationError;
        }
      });

      if (mode === "initial") {
        await agent.prompt(target);
      } else {
        await agent.prompt("Input A");
      }

      expect(publishedMessage).toBe(true);
      expect(beforeCommit).toBeDefined();
      expect(publishedScope).toBeDefined();
      expect(publishedScope).not.toBe(beforeCommit);
      expect(agent.state.errorMessage).toBe(publicationError.message);
      expect(agent.state.messages.filter((message) => message === target)).toHaveLength(1);
      expect(agent.hasQueuedMessages()).toBe(false);

      await agent.continue();

      expect(requestMessages.at(-1)).toContain(target);
      expect(getInternalToolTurnInputScope(completion)).toBe(publishedScope);
      expect(agent.state.messages.filter((message) => message === target)).toHaveLength(1);
    },
  );

  it("restores drained steering in order when turn_end aborts before injection", async () => {
    const first = gate();
    const secondExecute = vi.fn(async () => emptyResult());
    const { agent, requests } = makeAgent(
      [
        {
          ...makeTool("first"),
          execute: async () => {
            await first.wait();
            return { content: text("first result"), details: {} };
          },
        },
        { ...makeTool("second"), execute: secondExecute },
      ],
      {
        steeringMode: "all",
        toolExecution: "sequential",
      },
    );
    agent.subscribe((event) => {
      if (event.type === "turn_end" && event.toolResults.length > 0) {
        agent.abort();
      }
    });
    const firstSteer = user("first steer", 2);
    const secondSteer = user("second steer", 3);

    const run = agent.prompt("start");
    await first.started;
    agent.steer(firstSteer);
    agent.steer(secondSteer);
    first.release();
    await run;

    expect(secondExecute).not.toHaveBeenCalled();
    expect(agent.state.messages).not.toContain(firstSteer);
    expect(agent.state.messages).not.toContain(secondSteer);
    expect(agent.hasQueuedMessages()).toBe(true);

    await agent.prompt("again");

    expect(requests).toHaveLength(2);
    expect(requests[1]?.slice(-2)).toEqual([firstSteer, secondSteer]);
    expect(agent.hasQueuedMessages()).toBe(false);
  });

  it("cancels a drained steering message and permits an explicit re-enqueue", async () => {
    const turn = gate();
    const { agent, requests } = makeAgent(
      [],
      { initialState: { messages: [makeAssistantMessage(text("ready"))] } },
      [done],
    );
    const target = user("cancel after drain", 2);
    agent.steer(target);
    agent.subscribe(async (event) => {
      if (event.type === "turn_start") {
        await turn.wait();
      }
    });

    const run = agent.continue();
    await turn.started;
    expect(agent.cancelSteeringMessage((message) => message === target)).toBe(target);
    turn.release();
    await run;

    expect(requests).toHaveLength(0);
    expect(agent.state.messages).not.toContain(target);
    expect(agent.hasQueuedMessages()).toBe(false);

    agent.steer(target);
    await agent.continue();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.at(-1)).toBe(target);
    expect(agent.state.messages).toContain(target);
  });

  it("restores drained follow-ups to their deferred queue in order", async () => {
    const { agent, requests } = makeAgent(
      [],
      {
        initialState: { messages: [makeAssistantMessage(text("ready"))] },
        followUpMode: "all",
      },
      [done, done],
    );
    const firstFollowUp = user("first follow-up", 2);
    const secondFollowUp = user("second follow-up", 3);
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

    expect(requests).toHaveLength(0);
    expect(agent.hasQueuedMessages()).toBe(true);

    await agent.prompt("again");

    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toContain(firstFollowUp);
    expect(requests[0]).not.toContain(secondFollowUp);
    expect(requests[1]?.slice(-2)).toEqual([firstFollowUp, secondFollowUp]);
    expect(agent.hasQueuedMessages()).toBe(false);
  });

  it("suppresses a later tool when steering arrives during private execution preflight", async () => {
    const preflight = gate();
    const { tool, execute, dispose } = preparedTool("delayed", async () => {
      await preflight.wait();
      return { rewritten: true };
    });
    const afterToolOutcome = vi.fn(async () => undefined);
    const { agent, requests } = makeAgent([makeTool("first"), tool], {
      toolExecution: "sequential",
      afterToolOutcome,
    });
    const { commitReadyCalls, releaseSkippedCalls } = trackBatch(agent);
    const steer = user("redirect", 2);

    const run = agent.prompt("start");
    await preflight.started;
    agent.steer(steer);
    preflight.release();
    await run;

    expect(execute).not.toHaveBeenCalled();
    expect(commitReadyCalls).toHaveBeenCalledExactlyOnceWith([{ toolCallId: "first", args: {} }]);
    expect(releaseSkippedCalls).toHaveBeenCalledExactlyOnceWith(["delayed"]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(requests[1]?.slice(-3)).toMatchObject([
      expectedToolResult("first", false),
      expectedToolResult("delayed", true, {
        details: { status: "skipped", deniedReason: "steering" },
      }),
      steer,
    ]);
    expectHook(afterToolOutcome, {
      toolCall: expect.objectContaining({ id: "delayed" }),
      args: { rewritten: true },
      executionStarted: false,
    });
  });

  it("uses private final args for parallel launch facts and hooks", async () => {
    const finalArgs = { rewritten: true };
    const { tool, execute } = preparedTool("rewritten", () => finalArgs);
    const afterToolCall = vi.fn(async () => undefined);
    const afterToolOutcome = vi.fn(async () => undefined);
    const { agent } = makeAgent([tool], {
      toolExecution: "parallel",
      afterToolCall,
      afterToolOutcome,
    });
    const { commitReadyCalls } = trackBatch(agent);

    await agent.prompt("start");

    expect(commitReadyCalls).toHaveBeenCalledExactlyOnceWith([
      { toolCallId: "rewritten", args: finalArgs },
    ]);
    expectHook(afterToolCall, { args: finalArgs });
    expectHook(afterToolOutcome, { args: finalArgs, executionStarted: true });
    expect(execute).toHaveBeenCalledOnce();
    expect(
      agent.state.messages.find(
        (message) => message.role === "assistant" && message.stopReason === "toolUse",
      ),
    ).toMatchObject({
      content: [expect.objectContaining({ id: "rewritten", arguments: {} })],
    });
  });

  it("disposes private preflight when the steering checkpoint throws", async () => {
    const { tool, execute, dispose } = preparedTool("cleanup");
    const getSteeringMessages = vi
      .fn<() => Promise<AgentMessage[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("steering checkpoint failed"));

    await expect(
      runLoop(
        [[makeCall("first"), makeCall("cleanup", "cleanup-call")]],
        { toolExecution: "sequential", getSteeringMessages },
        [makeTool("first"), tool],
      ).result,
    ).rejects.toThrow("steering checkpoint failed");
    expect(execute).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("delivers async steering after sequential tools before shouldStopAfterTurn", async () => {
    const steer = user("keep going", 2);
    const queued: AgentMessage[] = [];
    const secondExecute = vi.fn(async () => emptyResult());
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
    const run = runLoop(
      [[makeCall("first", "stop-first"), makeCall("second", "stop-second")], done],
      steeringConfig,
      [
        {
          ...makeTool("first"),
          execute: async () => {
            queued.push(steer);
            return { content: text("first result"), details: {} };
          },
        },
        { ...makeTool("second"), execute: secondExecute },
      ],
    );
    await run.result;

    expect(run.requests).toHaveLength(2);
    expect(run.requests[1]?.at(-1)).toBe(steer);
    expect(secondExecute).toHaveBeenCalledTimes(0);
    expect(shouldStopAfterTurn).toHaveBeenCalledOnce();
    expect(getSteeringMessages).toHaveBeenCalled();
  });

  it("commits drained steering and settled tools before a host-requested model-step stop", async () => {
    const steer = user("verify the new version", 2);
    const queued: AgentMessage[] = [];
    const execute = vi.fn(async () => {
      queued.push(steer);
      return { content: text("reload committed"), details: {} };
    });
    let refresh = false;
    const run = runLoop(
      [[makeCall("reload", "reload-once")], text("must not run on the old catalog")],
      {
        getSteeringMessages: async () => queued.splice(0),
        afterToolCall: async () => {
          refresh = true;
        },
        prepareNextTurn: async () => (refresh ? { stop: true } : undefined),
      },
      [{ ...makeTool("reload"), execute }],
      "edit and reload",
    );
    const result = await run.result;

    expect(run.requests).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(result.at(-1)).toBe(steer);
    expect(result).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "reload-once",
        content: [{ type: "text", text: "reload committed" }],
      }),
    );
    expect(run.events.at(-1)).toMatchObject({ type: "agent_end", messages: result });
    expectInjectedOnce(run.events, steer);
    expect(queued).toEqual([]);
  });

  it("delivers steering admitted while the final follow-up drain is pending", async () => {
    const followUp = gate();
    const steer = user("one more thing", 2);
    const queued: AgentMessage[] = [];
    const run = runLoop([done, done], {
      getSteeringMessages: async () => queued.splice(0, 1),
      getFollowUpMessages: async () => {
        await followUp.wait();
        return [];
      },
    });

    await followUp.started;
    queued.push(steer);
    followUp.release();
    await run.result;

    expect(run.requests).toHaveLength(2);
    expect(run.requests[1]?.at(-1)).toBe(steer);
    expect(queued).toEqual([]);
  });

  it.each(["sequential", "parallel"] as const)(
    "keeps the first executable call when steering waits before %s launch",
    async (toolExecution) => {
      const preparation = gate();
      const execute = vi.fn(async () => emptyResult());
      const afterToolOutcome = vi.fn<NonNullable<AgentOptions["afterToolOutcome"]>>(
        async ({ toolCall }) =>
          toolCall.id === "invalid" ? { details: { observed: "pre-execution" } } : undefined,
      );
      const { agent, requests, events } = makeAgent(
        [
          {
            ...makeTool("required"),
            parameters: Type.Object({ value: Type.String() }),
            execute,
          },
          { ...makeTool("ready"), execute },
        ],
        {
          toolExecution,
          afterToolOutcome,
          beforeToolCall: async ({ toolCall }) => {
            if (toolCall.id === "prepared") {
              await preparation.wait();
            }
            return undefined;
          },
        },
        [
          [
            makeCall("required", "invalid"),
            makeCall("ready", "prepared"),
            makeCall("ready", "tail"),
          ],
          done,
        ],
      );
      const commitReadyCalls = vi.fn();
      const releaseSkippedCalls = vi.fn();
      setInternalBeforeToolBatch(agent, async ({ calls }) => {
        expect(calls.map((call) => call.toolCall.id)).toEqual(["invalid", "prepared", "tail"]);
        return attachInternalToolBatchLifecycle({}, { commitReadyCalls, releaseSkippedCalls });
      });
      const steer = user("before launch", 2);

      const run = agent.prompt("start");
      await preparation.started;
      agent.steer(steer);
      preparation.release();
      await run;

      expect(execute).toHaveBeenCalledTimes(toolExecution === "parallel" ? 2 : 1);
      expect(commitReadyCalls.mock.calls.flatMap(([calls]) => calls)).toEqual([
        { toolCallId: "invalid", args: {} },
        { toolCallId: "prepared", args: {} },
        ...(toolExecution === "parallel" ? [{ toolCallId: "tail", args: {} }] : []),
      ]);
      if (toolExecution === "parallel") {
        expect(releaseSkippedCalls).not.toHaveBeenCalled();
      } else {
        expect(releaseSkippedCalls).toHaveBeenCalledExactlyOnceWith(["tail"]);
      }
      expect(requests[1]?.slice(-5)).toMatchObject([
        { role: "assistant", stopReason: "toolUse" },
        expectedToolResult("invalid", true, { details: { observed: "pre-execution" } }),
        expectedToolResult("prepared", false),
        toolExecution === "parallel"
          ? expectedToolResult("tail", false)
          : expectedToolResult("tail", true, {
              content: [{ type: "text", text: "Skipped to process an incoming message." }],
              details: { status: "skipped", deniedReason: "steering" },
            }),
        steer,
      ]);
      const ends = events.filter((event) => event.type === "tool_execution_end");
      expect(ends.map(({ toolCallId, errorKind }) => [toolCallId, errorKind])).toEqual([
        ["invalid", "argument-validation"],
        ["prepared", undefined],
        ["tail", undefined],
      ]);
      expect(ends[0]).toMatchObject({
        executionStarted: false,
        result: { details: { observed: "pre-execution" } },
      });
      expectHook(afterToolOutcome, {
        args: {},
        executionStarted: false,
        errorKind: "argument-validation",
        isError: true,
        toolCall: expect.objectContaining({ id: "invalid", name: "required" }),
      });
      expectInjectedOnce(events, steer);
    },
  );

  it.each(["parallel", "mixed", "rejected-first"] as const)(
    "shares the committed plan and FIFO steering across %s streamed batches",
    async (mode) => {
      const executed: string[] = [];
      const firstSteer = user("first steer", 2);
      const secondSteer = user("second steer", 3);
      const calls: AgentToolCall[] = [
        { ...makeCall("first"), async: true },
        { ...makeCall("second"), async: true },
        makeCall("third"),
      ];
      const first = makeTool("first", executed);
      if (mode === "rejected-first") {
        first.parameters = Type.Object({ required: Type.String() });
      }
      const second = makeTool("second", executed);
      if (mode === "mixed") {
        second.executionMode = "sequential";
      }
      const tools = [first, second, makeTool("third", executed)];
      if (mode === "parallel") {
        const release = createDeferred();
        for (const tool of tools) {
          const execute = tool.execute;
          tool.execute = async (...args) => {
            const result = await execute(...args);
            if (executed.length === tools.length) {
              release.resolve();
            }
            await release.promise;
            return result;
          };
        }
      }
      const { agent, requests, events } = makeAgent(tools, {
        toolExecution: mode === "parallel" || mode === "mixed" ? "parallel" : "sequential",
        steeringMode: "one-at-a-time",
        streamFn: () => {
          if (requests.length > 1) {
            return reply(makeAssistantMessage(text("handled steer")));
          }
          agent.steer(firstSteer);
          agent.steer(secondSteer);
          const stream = createAssistantMessageEventStream();
          startToolCalls(stream, calls.slice(0, 2));
          finishMessageStream(stream, makeAssistantMessage(calls), "toolUse");
          return stream;
        },
      });

      await agent.prompt("start");

      expect(executed).toEqual(
        {
          parallel: ["first", "second", "third"],
          mixed: ["first", "third"],
          "rejected-first": ["second"],
        }[mode],
      );
      expect(requests).toHaveLength(3);
      expect(requests[1]?.at(-1)).toBe(firstSteer);
      expect(requests[1]).not.toContain(secondSteer);
      expect(requests[2]?.at(-1)).toBe(secondSteer);
      expect(
        requests[1]
          ?.filter((message) => message.role === "toolResult")
          .map((message) => message.toolCallId),
      ).toEqual(["first", "second", "third"]);
      for (const steer of [firstSteer, secondSteer]) {
        expectInjectedOnce(events, steer);
      }
      expect(agent.hasQueuedMessages()).toBe(false);
    },
  );

  it("drains again after an empty synchronous streamed checkpoint", async () => {
    const queued: AgentMessage[] = [];
    const getSteeringMessages = async () => queued.splice(0);
    attachInternalSyncSteeringGetter(getSteeringMessages, () => queued.splice(0));
    const streamed = createStreamedSteeringConfig({ ...config, getSteeringMessages });
    const steer = user("steer", 2);

    const first = streamed.config.getSteeringMessages?.();
    queued.push(steer);
    const second = streamed.config.getSteeringMessages?.();

    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toEqual([steer]);
    await expect(streamed.config.getSteeringMessages?.()).resolves.toEqual([steer]);
    expect(streamed.getTerminalConfig()).toBe(streamed.config);
  });
});

const activeModel = { ...model, id: "steerable-model", name: "Steerable model", reasoning: true };

function streamAssistant(value: string): AssistantMessage {
  return { ...makeAssistantMessage(text(value)), model: activeModel.id, timestamp: 2 };
}

async function activeResponse(
  options: Pick<AgentOptions, "steeringMode" | "convertToLlm" | "transformContext"> & {
    steer?: (messages: readonly UserMessage[]) => Promise<boolean>;
    tools?: AgentTool[];
    needsContinuation?: () => boolean;
  } = {},
) {
  const { needsContinuation } = options;
  const started = createDeferred();
  const submitted = createDeferred();
  const steer = vi.fn(async (messages: readonly UserMessage[]) => {
    submitted.resolve();
    return options.steer ? options.steer(messages) : true;
  });
  const firstResponse = createAssistantMessageEventStream();
  let disconnect: ReturnType<NonNullable<StreamOptions["onActiveResponse"]>>;
  const streamFn: AgentOptions["streamFn"] = (_model, _context, streamOptions) => {
    if (requests.length === 1) {
      disconnect = streamOptions?.onActiveResponse?.({ steer, needsContinuation });
      firstResponse.push({ type: "start", partial: streamAssistant("") });
      started.resolve();
      return firstResponse;
    }
    const response = createAssistantMessageEventStream();
    finishMessageStream(response, streamAssistant("updated answer"));
    return response;
  };
  const { agent, requests } = makeAgent(options.tools ?? [], {
    initialState: { model: activeModel },
    streamFn,
    ...options,
  });
  const run = agent.prompt("original question");
  await started.promise;
  return {
    steer,
    submitted: submitted.promise,
    agent,
    requests,
    firstResponse,
    finish: (message = streamAssistant("original answer")) => {
      disconnect?.();
      finishMessageStream(firstResponse, message, "stop");
      return run;
    },
    fail: () => {
      disconnect?.();
      finishMessageStream(firstResponse, {
        ...streamAssistant(""),
        stopReason: "error",
        errorMessage: "provider failed",
      });
      return run;
    },
  };
}

it.each(["one-at-a-time", "all"] as const)(
  "projects context and finishes an accepted batch before later %s updates",
  async (steeringMode) => {
    const { agent, steer, finish, requests } = await activeResponse({
      steeringMode,
      transformContext: async (messages) => {
        let userTurn = 0;
        return messages.map((message) =>
          message.role === "user"
            ? { ...message, content: `Turn ${++userTurn}: ${JSON.stringify(message.content)}` }
            : message,
        );
      },
    });

    const firstUpdate = user("first update", 3);
    agent.steer(firstUpdate);
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    agent.steer(user("second update", 4));
    await setImmediate();
    await finish();
    expect(steer).toHaveBeenCalledExactlyOnceWith([requests[1]?.at(-1)]);
    expect(requests[1]?.at(-1)).toMatchObject({ role: "user", content: 'Turn 2: "first update"' });
    expect(requests[2]?.at(-1)).toMatchObject({ content: 'Turn 3: "second update"' });
    expect(agent.state.messages).toContain(firstUpdate);
  },
);

it.each([false, true])(
  "queues incompatible context after accepted input=%s",
  async (acceptedInput) => {
    const update = user("change direction", 3);
    const { agent, steer, finish, requests } = await activeResponse({
      steeringMode: "all",
      transformContext: async (messages) =>
        messages.includes(update) ? messages.filter((message) => message === update) : messages,
    });

    const earlier = user("accepted update", 2);
    if (acceptedInput) {
      agent.steer(earlier);
      await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    }
    agent.steer(update);
    await setImmediate();
    await finish();
    expect(steer).toHaveBeenCalledTimes(acceptedInput ? 1 : 0);
    expect(requests[1]?.at(-1)).toBe(acceptedInput ? earlier : update);
    expect(requests[acceptedInput ? 2 : 1]).toEqual([update]);
  },
);

it.each(["abort", "error"] as const)(
  "releases admitted input for cancellation after the run ends with %s",
  async (terminal) => {
    const { agent, submitted, finish, fail } = await activeResponse();

    const update = user("recoverable update", 3);
    agent.steer(update);
    await submitted;
    expect(agent.cancelSteeringMessage((message) => message === update)).toBeUndefined();
    if (terminal === "abort") {
      agent.abort();
      await finish();
    } else {
      await fail();
    }
    expect(agent.state.messages).not.toContain(update);
    expect(agent.hasQueuedMessages()).toBe(true);
    expect(agent.cancelSteeringMessage((message) => message === update)).toBe(update);
    expect(agent.hasQueuedMessages()).toBe(false);
  },
);
it("continues after an automatic response when transport still owns deferred tool input", async () => {
  let deferredInput = false;
  const needsContinuation = vi.fn(() => deferredInput);
  const { finish, requests, agent } = await activeResponse({ needsContinuation });

  deferredInput = true;
  await finish();
  expect(requests).toHaveLength(2);
  expect(requests[1]?.at(-1)).toMatchObject({ role: "assistant" });
  expect(needsContinuation).toHaveBeenCalledOnce();
  expect(agent.state.messages.at(-1)).toMatchObject({
    content: [{ type: "text", text: "updated answer" }],
  });
});
it.each(["one-at-a-time", "all"] as const)(
  "keeps a drained %s steering batch ahead of later input while an async call settles",
  async (steeringMode) => {
    const settled = createDeferred();

    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const { agent, submitted, firstResponse, steer, finish, requests } = await activeResponse({
      steeringMode,
      tools: [{ ...makeTool("lookup"), parameters: Type.Object({}), execute }],
    });
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end") {
        settled.resolve();
      }
    });

    const first = user("first update", 3);
    const second = user("second update", 4);
    agent.steer(first);
    await submitted;
    const toolCall = { ...makeCall("lookup", "call_1"), async: true as const };
    const partial = { ...streamAssistant(""), content: [toolCall] };
    firstResponse.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
    await settled.promise;
    agent.steer(second);
    await setImmediate();
    expect(steer).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledOnce();
    await finish({
      ...streamAssistant("original answer"),
      content: [toolCall, { type: "text", text: "original answer" }],
    });
    expect(requests[1]?.at(-1)).toBe(first);
    expect(requests[2]?.at(-1)).toBe(second);
  },
);
it("sends queued input before generation ends and commits it once at the normal boundary", async () => {
  const { agent, submitted, steer, finish, requests } = await activeResponse();

  const update = user("change direction", 3);
  const later = user("later update", 4);
  agent.steer(update);
  await submitted;
  expect(steer).toHaveBeenCalledWith([update]);
  expect(agent.state.messages).not.toContain(update);

  agent.steer(later);
  await setImmediate();
  expect(steer).toHaveBeenCalledTimes(1);
  expect(agent.cancelSteeringMessage((message) => message === update)).toBeUndefined();
  agent.clearSteeringQueue();
  await finish();

  expect(requests).toHaveLength(2);
  expect(requests[1]?.at(-1)).toBe(update);
  expect(agent.state.messages.filter((message) => message === update)).toHaveLength(1);
  expect(agent.state.messages).not.toContain(later);
  expect(agent.hasQueuedMessages()).toBe(false);
  agent.steer(user("next run", 5));
  expect(steer).toHaveBeenCalledTimes(1);
});

it("allows cancellation after definite rejection but fences cancellation during admission", async () => {
  const decision = createDeferred<boolean>();

  const { agent, submitted, steer, finish, requests } = await activeResponse({
    steer: async () => decision.promise,
    steeringMode: "all",
  });

  const update = user("optional update", 3);
  agent.steer(update);
  await submitted;
  expect(agent.cancelSteeringMessage((message) => message === update)).toBeUndefined();
  decision.resolve(false);
  await setImmediate();
  const later = user("later update", 4);
  agent.steer(later);
  await setImmediate();
  expect(steer).toHaveBeenCalledTimes(1);
  expect(agent.cancelSteeringMessage((message) => message === update)).toBe(update);
  await finish();
  expect(requests).toHaveLength(2);
  expect(requests[1]?.at(-1)).toBe(later);
  expect(agent.state.messages).not.toContain(update);
});

it("does not submit input after abort wins an awaited conversion", async () => {
  const converting = createDeferred();
  const converted = createDeferred<Message[]>();

  const update = user("late update", 3);
  const { agent, requests, finish, steer } = await activeResponse({
    convertToLlm: (messages) => {
      if (messages.includes(update)) {
        converting.resolve();
        return converted.promise;
      }
      return messages as Message[];
    },
  });

  agent.steer(update);
  await converting.promise;
  agent.abort();
  converted.resolve([...requests.flat(), update]);
  await finish();
  expect(steer).not.toHaveBeenCalled();
  expect(agent.cancelSteeringMessage((message) => message === update)).toBe(update);
});
