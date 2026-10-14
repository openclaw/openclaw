import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createStreamedSteeringConfig } from "./agent-loop-steering.js";
import { runAgentLoop } from "./agent-loop.js";
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
import {
  attachInternalSyncSteeringGetter,
  attachInternalToolBatchLifecycle,
  attachInternalToolExecutionPreparer,
  setInternalBeforeToolBatch,
} from "./internal-hooks.js";
import { createAssistantMessageEventStream, type Message } from "./llm.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentToolCall,
} from "./types.js";

describe("agentLoop steering", () => {
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

  it("suppresses a later tool when steering arrives during private execution preflight", async () => {
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
      initialState: { model, tools: [makeTool("first"), tool] },
      streamFn: createTurnSequenceStream(
        [
          [makeCall("first"), makeCall("delayed", "delayed-call")],
          [{ type: "text", text: "redirected" }],
        ],
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
    expect(commitReadyCalls).toHaveBeenCalledExactlyOnceWith([{ toolCallId: "first", args: {} }]);
    expect(releaseSkippedCalls).toHaveBeenCalledExactlyOnceWith(["delayed-call"]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(requestMessages[1]?.slice(-3)).toMatchObject([
      { role: "toolResult", toolCallId: "first", isError: false },
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
        { systemPrompt: "", messages: [], tools: [makeTool("first"), tool] },
        { ...config, toolExecution: "sequential", getSteeringMessages },
        () => {},
        undefined,
        createTurnSequenceStream([[makeCall("first"), makeCall("cleanup", "cleanup-call")]], []),
      ),
    ).rejects.toThrow("steering checkpoint failed");
    expect(execute).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("delivers async steering after sequential tools before shouldStopAfterTurn", async () => {
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
    expect(secondExecute).toHaveBeenCalledTimes(0);
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

  it.each(["sequential", "parallel"] as const)(
    "keeps the first executable call when steering waits before %s launch",
    async (toolExecution) => {
      const preparationReleased = createDeferred();
      const preparationBlocked = createDeferred();
      const execute = vi.fn(async () => ({ content: [], details: {} }));
      const requestMessages: Message[][] = [];
      const streamFn = createTurnSequenceStream(
        [
          [
            makeCall("required", "invalid"),
            makeCall("ready", "prepared"),
            makeCall("ready", "tail"),
          ],
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
            { ...makeTool("ready"), execute },
          ],
        },
        streamFn,
        toolExecution,
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
        expect(calls.map((call) => call.toolCall.id)).toEqual(["invalid", "prepared", "tail"]);
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
      expect(requestMessages[1]?.slice(-5)).toMatchObject([
        { role: "assistant", stopReason: "toolUse" },
        { role: "toolResult", toolCallId: "invalid", isError: true },
        { role: "toolResult", toolCallId: "prepared", isError: false },
        toolExecution === "parallel"
          ? { role: "toolResult", toolCallId: "tail", isError: false }
          : {
              role: "toolResult",
              toolCallId: "tail",
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
        { id: "tail", kind: undefined },
      ]);
      expect(
        events.filter((event) => event.type === "message_end" && event.message === steer),
      ).toHaveLength(1);
    },
  );

  it.each(["parallel", "mixed", "rejected-first"] as const)(
    "shares the committed plan and FIFO steering across %s streamed batches",
    async (mode) => {
      const executed: string[] = [];
      const requests: Message[][] = [];
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
      const agent = new Agent({
        initialState: { model, tools },
        toolExecution: mode === "parallel" || mode === "mixed" ? "parallel" : "sequential",
        steeringMode: "one-at-a-time",
        streamFn: (_model, context) => {
          requests.push(context.messages.slice());
          if (requests.length > 1) {
            return reply(makeAssistantMessage([{ type: "text", text: "handled steer" }]));
          }
          agent.steer(firstSteer);
          agent.steer(secondSteer);
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "start", partial: makeAssistantMessage([]) });
          for (const [contentIndex, toolCall] of calls.slice(0, 2).entries()) {
            stream.push({
              type: "toolcall_end",
              contentIndex,
              toolCall,
              partial: makeAssistantMessage(calls.slice(0, contentIndex + 1)),
            });
          }
          stream.push({ type: "done", reason: "toolUse", message: makeAssistantMessage(calls) });
          stream.end();
          return stream;
        },
      });
      const events: AgentEvent[] = [];
      agent.subscribe((event) => {
        events.push(event);
      });

      await agent.prompt("start");

      expect(executed).toEqual(
        mode === "parallel"
          ? ["first", "second", "third"]
          : mode === "mixed"
            ? ["first", "third"]
            : mode === "rejected-first"
              ? ["second"]
              : ["first"],
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
        expect(
          events.filter((event) => event.type === "message_end" && event.message === steer),
        ).toHaveLength(1);
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
