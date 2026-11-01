import { setImmediate as flushEventLoop } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import { Type } from "typebox";
import { expect, it, onTestFinished } from "vitest";
import {
  captureAgent,
  createTurnSequenceStream,
  makeCall,
  makeAssistantMessage,
  startToolCalls,
  finishMessageStream,
  makeTool,
  user,
} from "../../../../packages/agent-core/src/agent-loop.test-support.js";
import {
  REPEATED_TOOL_ERROR_CODE,
  ToolArgumentValidationError,
} from "../../../../packages/agent-core/src/errors.js";
import {
  attachInternalToolExecutionPreparer,
  setInternalBeforeToolBatch,
} from "../../../../packages/agent-core/src/internal-hooks.js";
import type { AgentToolCall } from "../../../../packages/agent-core/src/types.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { markCodeModeControlTool } from "../../code-mode-control-tools.js";
import { createToolLoopBatchAdmission } from "./tool-loop-recovery.js";

const fail: ReturnType<typeof makeTool>["execute"] = async () => {
  throw new Error("same failure");
};
function probe(execute = fail) {
  return { ...makeTool("probe"), execute };
}
function calls(...ids: string[]) {
  return ids.map((id) => makeCall("probe", id));
}
function answer(text = "done") {
  return [{ type: "text" as const, text }];
}
function callTurns(count: number) {
  return Array.from({ length: count }, (_, index) => calls(`call-${index}`));
}

function runAgent(
  turns: Parameters<typeof createTurnSequenceStream>[0],
  tools = [probe()],
  options: Parameters<typeof captureAgent>[1] = {},
) {
  const captured = captureAgent(tools, options, turns);
  setInternalBeforeToolBatch(captured.agent, createToolLoopBatchAdmission({}));
  return captured;
}

it("requests a changed fourth plan with recovery feedback on the last failed result", async () => {
  let failures = 0;
  const progress: string[] = [];
  const { agent, requests } = captureAgent(
    [
      probe(async () => {
        failures++;
        throw new Error("same failure");
      }),
      makeTool("inspect", progress),
    ],
    {},
    [...callTurns(3), [makeCall("inspect")], answer()],
  );
  setInternalBeforeToolBatch(agent, createToolLoopBatchAdmission({}));
  const requestPrefixes: string[] = [];
  const stream = agent.streamFn;
  agent.streamFn = (...args) => {
    requestPrefixes.push(JSON.stringify(args[1].messages));
    return stream(...args);
  };
  await agent.prompt("start");
  expect(requests).toHaveLength(5);
  expect(failures).toBe(3);
  expect(progress).toEqual(["inspect"]);
  expect(requests[3]?.at(-1)).toMatchObject({
    role: "toolResult",
    content: [
      { type: "text", text: "same failure" },
      { type: "text", text: expect.stringContaining("Do not repeat this exact tool action") },
    ],
  });
  expect(JSON.stringify(requests[3]?.slice(0, requests[2]?.length))).toBe(requestPrefixes[2]);
  expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: "stop" });
  expect(agent.state.errorMessage).toBeUndefined();
});

it.each([true, false])(
  "never starts an unchanged fourth call after unrelated progress (available=%s)",
  async (available) => {
    let failures = 0;
    const progress: string[] = [];
    const { agent, requests } = captureAgent(
      [
        ...(available
          ? [
              probe(async () => {
                failures++;
                throw new Error("same failure");
              }),
            ]
          : []),
        makeTool("inspect", progress),
      ],
      {},
      [...callTurns(3), [makeCall("inspect")], calls("quarantined")],
    );
    setInternalBeforeToolBatch(
      agent,
      createToolLoopBatchAdmission({ loopDetection: { enabled: false } }),
    );
    await agent.prompt("start");
    expect(requests).toHaveLength(5);
    expect(failures).toBe(available ? 3 : 0);
    expect(progress).toEqual(["inspect"]);
    expect(agent.state.messages.at(-1)).toMatchObject({ errorCode: REPEATED_TOOL_ERROR_CODE });
    expect(
      agent.state.messages.find((m) => m.role === "toolResult" && m.toolCallId === "quarantined"),
    ).toMatchObject(
      available
        ? {
            details: { status: "blocked", deniedReason: "tool-loop" },
          }
        : {
            isError: true,
            content: [{ type: "text", text: "Tool probe not found" }],
          },
    );
  },
);

it.each(["thrown", "unknown name", "returned failure", "invalid schema", "prepare validation"])(
  "quarantines repeated %s errors before a fourth implementation starts",
  async (failure) => {
    let executions = 0;
    const tool = probe(async () => {
      executions++;
      if (failure === "returned failure") {
        return {
          content: [{ type: "text", text: "Resource unavailable" }],
          details: { status: "error" },
        };
      }
      throw new Error("HTTP 503 private diagnostics");
    });
    if (failure === "invalid schema") {
      tool.parameters = Type.Object({ required: Type.String() });
    }
    if (failure === "prepare validation") {
      tool.prepareArguments = () => {
        throw new ToolArgumentValidationError("private validator input");
      };
    }
    const { agent, requests, events } = runAgent(
      callTurns(4),
      failure === "unknown name" ? [] : [tool],
    );
    await agent.prompt("start");
    expect(requests).toHaveLength(4);
    expect(executions).toBe(failure === "thrown" || failure === "returned failure" ? 3 : 0);
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorCode: REPEATED_TOOL_ERROR_CODE,
      errorMessage: expect.stringContaining(
        "probe call failed 3 times (" +
          (failure === "unknown name"
            ? "unknown tool"
            : failure.includes("validation") || failure === "invalid schema"
              ? "invalid arguments"
              : "tool error") +
          ")",
      ),
    });
    expect(
      events.filter((e) => e.type === "tool_execution_end" && e.executionStarted),
    ).toHaveLength(executions);
    expect(agent.state.messages.filter((m) => m.role === "toolResult")).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({ type: "agent_end" });
  },
);

it.each(["sequential", "parallel"] as const)(
  "settles the %s batch and grants one recovery after its third error",
  async (toolExecution) => {
    let executions = 0;
    const { agent, requests, events } = runAgent(
      [calls("one", "two", "three", "four", "five"), calls("retry")],
      [
        probe(async () => {
          executions++;
          throw new Error("same failure");
        }),
      ],
      { toolExecution },
    );
    await agent.prompt("start");
    expect(requests).toHaveLength(2);
    const feedback = requests[1]?.filter((m) => m.role === "toolResult").flatMap((m) => m.content);
    expect(JSON.stringify(feedback)).not.toContain("OpenClaw stopped this turn");
    expect(executions).toBe(toolExecution === "sequential" ? 3 : 5);
    expect(agent.state.messages.filter((m) => m.role === "toolResult")).toHaveLength(6);
    expect(
      events.filter((e) => e.type === "tool_execution_end" && e.executionStarted),
    ).toHaveLength(executions);
    expect(agent.state.messages.at(-1)).toMatchObject({
      stopReason: "error",
      errorCode: REPEATED_TOOL_ERROR_CODE,
    });
  },
);

it("counts parallel results in source order despite a success settling first", async () => {
  const releaseFailures = createDeferred();
  const completed: string[] = [];
  const tool = probe(async (id) => {
    if (id === "success") {
      return { content: [{ type: "text", text: "progress" }], details: {} };
    }
    await releaseFailures.promise;
    throw new Error("same failure");
  });
  const { agent, requests } = runAgent(
    [calls("first", "second", "success", "fourth", "fifth"), answer()],
    [tool],
  );
  agent.subscribe((event) => {
    if (event.type === "tool_execution_end") {
      completed.push(event.toolCallId);
      if (event.toolCallId === "success") {
        releaseFailures.resolve();
      }
    }
  });
  const running = agent.prompt("start");
  onTestFinished(async () => {
    releaseFailures.resolve();
    await running;
  });
  await running;
  expect(completed[0]).toBe("success");
  expect(completed).toHaveLength(5);
  expect(requests).toHaveLength(2);
  expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: "stop" });
  expect(agent.state.errorMessage).toBeUndefined();
});

it("keeps the streak and quarantine across continue but releases them for committed user input", async () => {
  let executions = 0;
  const { agent, requests } = runAgent(
    callTurns(4),
    [
      probe(async () => {
        executions++;
        throw new Error("same failure");
      }),
    ],
    {
      afterToolOutcome: async () => ({ terminate: true }),
    },
  );
  await agent.prompt("start");
  await agent.continue();
  await agent.continue();
  expect(requests).toHaveLength(3);
  expect(executions).toBe(3);
  expect(agent.state.messages.at(-1)).toMatchObject({ role: "toolResult" });
  await agent.continue();
  expect(requests).toHaveLength(4);
  expect(executions).toBe(3);
  expect(agent.state.messages.at(-1)).toMatchObject({ errorCode: REPEATED_TOOL_ERROR_CODE });
  agent.streamFn = createTurnSequenceStream(callTurns(1), requests);
  await agent.prompt("try again");
  expect(requests).toHaveLength(5);
  expect(executions).toBe(4);
  expect(agent.state.messages.at(-1)).toMatchObject({ role: "toolResult" });
  expect(agent.state.errorMessage).toBeUndefined();
});

it.each([
  { queue: "followUp", delivery: "active" },
  { queue: "followUp", delivery: "continue" },
  { queue: "steer", delivery: "active" },
  { queue: "steer", delivery: "continue" },
] as const)(
  "renews quarantine and recovery only when $queue commits through $delivery",
  async ({ queue, delivery }) => {
    const freshInput = user("second request", 2);
    const activeSteer = queue === "steer" && delivery === "active";
    let executions = 0;
    const { agent, requests } = runAgent(
      [
        ...callTurns(3),
        ...(activeSteer ? [] : [answer("first answer")]),
        ...callTurns(3),
        answer("second answer"),
      ],
      [
        probe(async () => {
          executions++;
          throw new Error("same failure");
        }),
      ],
    );
    if (delivery === "active") {
      agent.subscribe((event) => {
        if (
          event.type === "message_end" &&
          event.message.role === "toolResult" &&
          event.message.toolCallId === "call-2" &&
          executions === 3
        ) {
          agent[queue](freshInput);
        }
      });
    }
    await agent.prompt("first request");
    if (delivery === "continue") {
      agent[queue](freshInput);
      await agent.continue();
    }
    expect(agent.state.messages).toContain(freshInput);
    expect(executions).toBe(6);
    expect(requests).toHaveLength(activeSteer ? 7 : 8);
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "second answer" }],
    });
    expect(agent.state.errorMessage).toBeUndefined();
  },
);

it("allows failed changed diagnostics and approval denial without another special intervention", async () => {
  const executed: string[] = [];
  const { agent, requests } = runAgent(
    [
      ...callTurns(3),
      [makeCall("inspect", "denied")],
      [makeCall("inspect", "failed")],
      answer("ask the user"),
    ],
    [
      probe(),
      {
        ...makeTool("inspect"),
        execute: async (id) => {
          executed.push(id);
          throw new Error("different diagnostic failure");
        },
      },
    ],
    {
      beforeToolCall: async ({ toolCall }) =>
        toolCall.id === "denied" ? { block: true, reason: "approval denied" } : undefined,
    },
  );
  await agent.prompt("start");
  expect(requests).toHaveLength(6);
  expect(executed).toEqual(["failed"]);
  expect(agent.state.messages.at(-1)).toMatchObject({
    stopReason: "stop",
    content: [{ type: "text", text: "ask the user" }],
  });
  expect(agent.state.errorMessage).toBeUndefined();
});

it.each(["pending sequential", "started parallel", "pending source guard"] as const)(
  "blocks only unstarted streamed work: %s",
  async (kind) => {
    const admitted = createDeferred();
    const triggerObserved = createDeferred();
    const response = createAssistantMessageEventStream();
    const starts: string[] = [];
    const aborted: boolean[] = [];
    const third = probe(async (id, _args, signal) => {
      starts.push(id);
      if (id === "third") {
        await admitted.promise;
      }
      if (id === "sibling") {
        admitted.resolve();
        await triggerObserved.promise;
      }
      aborted.push(signal?.aborted ?? false);
      throw new Error("same failure");
    });
    const barrier = { ...makeTool("barrier"), executionMode: "sequential" as const };
    const { agent, requests, events } = runAgent([...callTurns(2)], [third, barrier]);
    const admission = createToolLoopBatchAdmission({ loopDetection: { enabled: false } });
    setInternalBeforeToolBatch(agent, async (context, signal) => {
      const result = await admission(context, signal);
      if (
        kind !== "started parallel" &&
        context.calls.some((call) => call.toolCall.id === "sibling")
      ) {
        admitted.resolve();
      }
      return result;
    });
    if (kind === "pending source guard") {
      attachInternalToolExecutionPreparer(third, async ({ toolCallId, args, signal }) => ({
        kind: "ready",
        args,
        dispose: () => {},
        execute: async (onStart) => {
          if (toolCallId === "sibling") {
            await triggerObserved.promise;
          }
          onStart?.();
          return third.execute(toolCallId, args, signal);
        },
      }));
    }
    const initial = agent.streamFn;
    const recovery = createTurnSequenceStream([answer("replanned")]);
    let turn = 0;
    agent.streamFn = (...args) => {
      turn++;
      if (turn < 3) {
        return initial(...args);
      }
      requests.push(args[1].messages.slice());
      return turn === 3 ? response : recovery(...args);
    };
    agent.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "toolResult" &&
        event.message.toolCallId === "third"
      ) {
        triggerObserved.resolve();
      }
    });
    const running = agent.prompt("start");
    onTestFinished(async () => {
      admitted.resolve();
      triggerObserved.resolve();
      response.end({ ...makeAssistantMessage([]), stopReason: "aborted" });
      await running;
    });
    const streamedCalls: AgentToolCall[] = [
      { ...makeCall("probe", "third"), async: true },
      ...(kind === "pending sequential" ? [makeCall("barrier")] : []),
      { ...makeCall("probe", "sibling"), async: true },
    ];
    startToolCalls(response, streamedCalls);
    finishMessageStream(response, makeAssistantMessage(streamedCalls));
    await running;
    expect(requests).toHaveLength(4);
    expect(starts).toEqual(
      kind === "started parallel"
        ? ["call-0", "call-1", "third", "sibling"]
        : ["call-0", "call-1", "third"],
    );
    expect(aborted).not.toContain(true);
    const outcome = events.find(
      (event) => event.type === "tool_execution_end" && event.toolCallId === "sibling",
    );
    expect(outcome).toMatchObject({ executionStarted: kind === "started parallel" });
    if (outcome?.type === "tool_execution_end") {
      expect(outcome.result).toMatchObject({
        content: [
          {
            type: "text",
            text:
              kind === "started parallel"
                ? "same failure"
                : "This tool was not executed because tool-loop recovery blocked further execution. Reassess the task before choosing the next action.",
          },
        ],
      });
    }
    expect(agent.state.messages.at(-1)).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "replanned" }],
    });
    expect(agent.state.errorMessage).toBeUndefined();
  },
);

it.each(["context prompt", "cancelled steer"] as const)(
  "does not replenish recovery for %s",
  async (input) => {
    let executions = 0;
    const { agent, requests } = runAgent(callTurns(4), [
      probe(async () => {
        executions++;
        throw new Error("same failure");
      }),
    ]);
    await agent.prompt("start");
    expect(requests).toHaveLength(4);
    expect(executions).toBe(3);
    agent.streamFn = createTurnSequenceStream(
      calls("blocked").map((call) => [call]),
      requests,
    );
    if (input === "context prompt") {
      await agent.prompt({
        role: "custom",
        customType: "openclaw.system-update",
        content: "context only",
        display: false,
        timestamp: 2,
      });
    } else {
      const cancelled = user("cancelled");
      agent.steer(cancelled);
      expect(agent.cancelSteeringMessage((message) => message === cancelled)).toBe(cancelled);
      await agent.continue();
      expect(agent.state.messages).not.toContain(cancelled);
    }
    expect(requests).toHaveLength(5);
    expect(executions).toBe(3);
    expect(agent.state.messages.at(-1)).toMatchObject({ errorCode: REPEATED_TOOL_ERROR_CODE });
  },
);

it("quarantines canonical Code Mode exec aliases even when only titles change", async () => {
  let executions = 0;
  const tool = markCodeModeControlTool({
    ...makeTool("exec"),
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async () => {
      executions++;
      throw new Error("same failure");
    },
  });
  const turns = ["code", "command", "code", "command"].map((alias, index) => [
    {
      ...makeCall("exec", String(index)),
      arguments: { [alias]: "return 1;", title: String(index) },
    },
  ]);
  const { agent, requests } = runAgent(turns, [tool]);
  await agent.prompt("start");
  expect(requests).toHaveLength(4);
  expect(executions).toBe(3);
  expect(agent.state.messages.at(-1)).toMatchObject({ errorCode: REPEATED_TOOL_ERROR_CODE });
});

it("drains an already-started mutation when a streamed unchanged retry ends recovery", async () => {
  const started = createDeferred();
  const modelStopped = createDeferred();
  const release = createDeferred();
  const response = createAssistantMessageEventStream();
  let mutationSignal: AbortSignal | undefined;
  let mutations = 0;
  let failures = 0;
  const mutation = {
    ...makeTool("mutate"),
    execute: async (_id: string, _args: unknown, signal?: AbortSignal) => {
      mutations++;
      mutationSignal = signal;
      started.resolve();
      await release.promise;
      return { content: [{ type: "text" as const, text: "committed" }], details: {} };
    },
  };
  const { agent, requests, events } = runAgent(callTurns(3), [
    probe(async () => {
      failures++;
      throw new Error("same failure");
    }),
    mutation,
  ]);
  const initial = agent.streamFn;
  let turn = 0;
  agent.streamFn = (...args) => {
    if (++turn < 4) {
      return initial(...args);
    }
    requests.push(args[1].messages.slice());
    args[2]?.signal?.addEventListener("abort", () => modelStopped.resolve(), { once: true });
    return response;
  };
  const running = agent.prompt("start");
  onTestFinished(async () => {
    release.resolve();
    response.end({ ...makeAssistantMessage([]), stopReason: "aborted" });
    await running;
  });
  const first: AgentToolCall = { ...makeCall("mutate"), async: true };
  startToolCalls(response, [first]);
  await started.promise;
  const retry: AgentToolCall = { ...makeCall("probe", "quarantined"), async: true };
  response.push({
    type: "toolcall_end",
    contentIndex: 1,
    toolCall: retry,
    partial: makeAssistantMessage([first, retry]),
  });
  await modelStopped.promise;
  expect(mutationSignal?.aborted).toBe(false);
  finishMessageStream(response, { ...makeAssistantMessage([first, retry]), stopReason: "aborted" });
  release.resolve();
  await running;
  expect(requests).toHaveLength(4);
  expect(mutations).toBe(1);
  expect(failures).toBe(3);
  expect
    .soft(
      agent.state.messages
        .filter((m) => m.role === "toolResult")
        .slice(-2)
        .map((m) => m.toolCallId),
    )
    .toEqual(["mutate", "quarantined"]);
  const mutationTurn = agent.state.messages.find(
    (m) =>
      m.role === "assistant" && m.content.some((c) => c.type === "toolCall" && c.id === "mutate"),
  );
  expect(mutationTurn?.role).toBe("assistant");
  if (mutationTurn?.role === "assistant") {
    expect(mutationTurn.turnId).toBeDefined();
    expect
      .soft(
        events
          .filter((e) => e.type === "turn_end")
          .filter((e) => e.message.role === "assistant" && e.message.turnId === mutationTurn.turnId)
          .map((e) => e.toolResults.map((m) => m.toolCallId)),
      )
      .toEqual([["mutate", "quarantined"]]);
  }
  expect(
    agent.state.messages.find((m) => m.role === "toolResult" && m.toolCallId === "mutate"),
  ).toMatchObject({ content: [{ type: "text", text: "committed" }] });
  expect(agent.state.messages.at(-1)).toMatchObject({ errorCode: REPEATED_TOOL_ERROR_CODE });
});

it("orders a late terminal-suppressed batch behind deferred result publication", async () => {
  const prefixCommitting = createDeferred();
  const releasePrefix = createDeferred();
  const resultPublishing = createDeferred();
  const releaseResult = createDeferred();
  const modelStopped = createDeferred();
  const response = createAssistantMessageEventStream();
  const starts: string[] = [];
  const tools = ["a", "b"].map((name) =>
    Object.assign(makeTool(name), {
      execute: async (id: string) => {
        starts.push(id);
        if (id === "b3") {
          await prefixCommitting.promise;
        }
        throw new Error("same failure");
      },
    }),
  );
  const { agent, requests, events } = runAgent(
    ["a1", "a2", "a3", "b1", "b2"].map((id) => [makeCall(id.slice(0, 1), id)]),
    [...tools, makeTool("c", starts)],
  );
  const initial = agent.streamFn;
  let turn = 0;
  agent.streamFn = (...args) => {
    if (++turn < 6) {
      return initial(...args);
    }
    requests.push(args[1].messages.slice());
    args[2]?.signal?.addEventListener("abort", () => modelStopped.resolve(), { once: true });
    return response;
  };
  agent.subscribe(async (event) => {
    if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      event.message.content.some((c) => c.type === "toolCall" && c.id === "c")
    ) {
      prefixCommitting.resolve();
      await releasePrefix.promise;
    }
    if (
      event.type === "message_start" &&
      event.message.role === "toolResult" &&
      event.message.toolCallId === "b3"
    ) {
      resultPublishing.resolve();
      await releaseResult.promise;
    }
  });
  const running = agent.prompt("start");
  onTestFinished(async () => {
    prefixCommitting.resolve();
    releasePrefix.resolve();
    releaseResult.resolve();
    response.end({ ...makeAssistantMessage([]), stopReason: "aborted" });
    await running;
  });
  const streamed: AgentToolCall[] = [
    { ...makeCall("b", "b3"), async: true },
    { ...makeCall("c"), async: true },
  ];
  startToolCalls(response, streamed, (content) => ({
    ...makeAssistantMessage(content),
    turnId: "late-batch-turn",
  }));
  await Promise.all([modelStopped.promise, resultPublishing.promise]);
  releasePrefix.resolve();
  // Drain the finite promise-only scheduling chain while B3 publication remains held.
  await flushEventLoop();
  expect
    .soft(
      events.some(
        (e) =>
          (e.type === "message_start" || e.type === "message_end") &&
          e.message.role === "toolResult" &&
          e.message.toolCallId === "c",
      ),
    )
    .toBe(false);
  releaseResult.resolve();
  finishMessageStream(response, {
    ...makeAssistantMessage(streamed),
    turnId: "late-batch-turn",
    stopReason: "aborted",
  });
  await running;
  expect(starts).toEqual(["a1", "a2", "a3", "b1", "b2", "b3"]);
  expect(requests).toHaveLength(6);
  expect
    .soft(
      agent.state.messages
        .filter((m) => m.role === "toolResult")
        .slice(-2)
        .map((m) => m.toolCallId),
    )
    .toEqual(["b3", "c"]);
  expect
    .soft(
      events
        .filter((e) => e.type === "turn_end")
        .filter((e) => e.message.role === "assistant" && e.message.turnId === "late-batch-turn")
        .map((e) => e.toolResults.map((m) => m.toolCallId)),
    )
    .toEqual([["b3", "c"]]);
  expect(agent.state.messages.at(-1)).toMatchObject({ errorCode: REPEATED_TOOL_ERROR_CODE });
});

it.each(["a", "b"].flatMap((retry) => ["streamed", "parallel"].map((mode) => ({ retry, mode }))))(
  "grants the first replan after two unseen $mode patterns and quarantines $retry",
  async ({ retry, mode }) => {
    const response = createAssistantMessageEventStream();
    const starts: string[] = [];
    const tools = ["a", "b"].map((name) =>
      Object.assign(makeTool(name), {
        execute: async (id: string) => {
          starts.push(id);
          throw new Error("same failure");
        },
      }),
    );
    const { agent, requests } = runAgent([], [...tools, makeTool("inspect")]);
    const recovery = createTurnSequenceStream(
      [[makeCall("inspect")], [makeCall(retry, "retry")]],
      requests,
    );
    const requestPrefixes: string[] = [];
    let first = true;
    agent.streamFn = (...args) => {
      requestPrefixes.push(JSON.stringify(args[1].messages));
      if (!first) {
        return recovery(...args);
      }
      first = false;
      requests.push(args[1].messages.slice());
      return response;
    };
    const running = agent.prompt("start");
    onTestFinished(async () => {
      response.end({ ...makeAssistantMessage([]), stopReason: "aborted" });
      await running;
    });
    const streamed = ["a1", "a2", "a3", "b1", "b2", "b3"].map((id) =>
      Object.assign(
        makeCall(id.slice(0, 1), id),
        mode === "streamed" ? { async: true as const } : {},
      ),
    );
    startToolCalls(response, streamed);
    finishMessageStream(response, makeAssistantMessage(streamed));
    await running;
    expect(requests).toHaveLength(3);
    expect(starts).toEqual(["a1", "a2", "a3", "b1", "b2", "b3"]);
    for (const name of ["a", "b"]) {
      expect(
        requests[1]?.find((m) => m.role === "toolResult" && m.toolCallId === `${name}3`),
      ).toMatchObject({
        content: [
          { type: "text", text: "same failure" },
          {
            type: "text",
            text: expect.stringContaining(
              `Tool-loop recovery: the same ${name} call failed 3 times (tool error).`,
            ),
          },
        ],
      });
    }
    expect(JSON.stringify(requests[1]?.slice(0, requests[0]?.length))).toBe(requestPrefixes[0]);
    expect(JSON.stringify(requests[2]?.slice(0, requests[1]?.length))).toBe(requestPrefixes[1]);
    expect(
      JSON.stringify(requests[1]?.filter((m) => m.role === "toolResult").flatMap((m) => m.content)),
    ).not.toContain("OpenClaw stopped this turn");
    expect(agent.state.messages.at(-1)).toMatchObject({ errorCode: REPEATED_TOOL_ERROR_CODE });
    expect(
      agent.state.messages.find((m) => m.role === "toolResult" && m.toolCallId === "retry"),
    ).toMatchObject({ details: { status: "blocked", deniedReason: "tool-loop" } });
  },
);
