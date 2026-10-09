import type { Message } from "@openclaw/llm-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  captureAgentLoop,
  config,
  createTurnSequenceStream,
  makeCall,
  makeTool,
  model,
  user,
} from "../../../../packages/agent-core/src/agent-loop.test-support.js";
import { Agent } from "../../../../packages/agent-core/src/agent.js";
import { REPEATED_TOOL_ERROR_CODE } from "../../../../packages/agent-core/src/errors.js";
import { setInternalBeforeToolBatch } from "../../../../packages/agent-core/src/internal-hooks.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createToolLoopBatchAdmission } from "./tool-loop-recovery.js";

describe("default repeated tool error termination", () => {
  it.each([undefined, false, true])(
    "records a terminal failure after three identical errors with loop detection %s",
    async (enabled) => {
      const requests: Message[][] = [];
      const tool = makeTool("probe");
      tool.execute = async () => {
        throw new Error("resource unavailable");
      };
      const run = captureAgentLoop(
        [user()],
        { systemPrompt: "", messages: [], tools: [tool] },
        {
          ...config,
          beforeToolBatch: createToolLoopBatchAdmission({
            sessionKey: `repeat-error-${enabled}`,
            runId: `repeat-error-${enabled}`,
            ...(enabled === undefined ? {} : { loopDetection: { enabled } }),
          }),
        },
        undefined,
        createTurnSequenceStream(
          [
            ...Array.from({ length: 3 }, (_, index) => [makeCall("probe", `call-${index}`)]),
            [{ type: "text", text: "[tool error]" }],
          ],
          requests,
        ),
      );
      const messages = await run.result;
      expect(requests).toHaveLength(3);
      expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(3);
      expect(messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "error",
        errorCode: REPEATED_TOOL_ERROR_CODE,
        errorMessage: expect.stringContaining("3 consecutive"),
        content: [{ type: "text", text: expect.stringContaining("native tool calling") }],
      });
      expect(run.events.at(-1)).toMatchObject({ type: "agent_end", messages });
    },
  );

  it.each([
    "changing errors",
    "changing unknown-tool errors",
    "changing send errors",
    "changing arguments",
    "successful polling",
    "successful retry",
  ])("preserves %s", async (scenario) => {
    let calls = 0;
    const tool = makeTool(scenario === "changing send errors" ? "sessions_send" : "probe");
    tool.parameters = Type.Object({ attempt: Type.Optional(Type.Number()) });
    tool.execute = async () => {
      calls++;
      if (scenario === "successful polling" || (scenario === "successful retry" && calls === 2)) {
        return { content: [{ type: "text", text: `progress ${calls}` }], details: {} };
      }
      throw new Error(
        scenario === "changing unknown-tool errors"
          ? `Unknown tool id: missing_tool; lookup failure ${calls}`
          : scenario === "changing errors" || scenario === "changing send errors"
            ? `failure ${calls}`
            : "same error",
      );
    };
    const turns = Array.from({ length: 4 }, (_, index) => [
      {
        ...makeCall(tool.name, `call-${index}`),
        arguments: scenario === "changing arguments" ? { attempt: index } : {},
      },
    ]);
    const run = captureAgentLoop(
      [user()],
      { systemPrompt: "", messages: [], tools: [tool] },
      {
        ...config,
        beforeToolBatch: createToolLoopBatchAdmission({ sessionKey: scenario, runId: scenario }),
      },
      undefined,
      createTurnSequenceStream([...turns, [{ type: "text", text: "done" }]]),
    );
    expect((await run.result).at(-1)).toMatchObject({ stopReason: "stop" });
    expect(calls).toBe(4);
  });

  it.each(["unknown name", "unknown id", "returned failure"])(
    "terminates repeated %s outcomes without another provider request",
    async (failure) => {
      const tool = makeTool("probe");
      tool.execute = async () => {
        if (failure === "unknown id") {
          throw new Error("Unknown tool id: missing_tool");
        }
        return {
          content: [{ type: "text", text: "Resource unavailable" }],
          details: { status: "error" },
        };
      };
      const run = captureAgentLoop(
        [user()],
        { systemPrompt: "", messages: [], tools: failure === "unknown name" ? [] : [tool] },
        { ...config, beforeToolBatch: createToolLoopBatchAdmission({}) },
        undefined,
        createTurnSequenceStream(
          Array.from({ length: 3 }, (_, index) => [makeCall("probe", `call-${index}`)]),
        ),
      );
      expect((await run.result).at(-1)).toMatchObject({ stopReason: "error" });
    },
  );

  it.each(["sequential", "parallel"] as const)(
    "settles the %s batch when the third error ends the turn",
    async (toolExecution) => {
      let calls = 0;
      const tool = makeTool("probe");
      tool.execute = async () => {
        calls++;
        throw new Error("same failure");
      };
      const run = captureAgentLoop(
        [user()],
        { systemPrompt: "", messages: [], tools: [tool] },
        {
          ...config,
          toolExecution,
          beforeToolBatch: createToolLoopBatchAdmission({}),
        },
        undefined,
        createTurnSequenceStream([
          Array.from({ length: 5 }, (_, index) => makeCall("probe", `call-${index}`)),
        ]),
      );
      const messages = await run.result;
      expect(calls).toBe(toolExecution === "sequential" ? 3 : 5);
      expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(5);
      expect(messages.at(-1)).toMatchObject({ stopReason: "error" });
    },
  );

  it("counts parallel results in assistant order despite a successful call settling first", async () => {
    const releaseFailures = createDeferred();
    const tool = makeTool("probe");
    tool.execute = async (id) => {
      if (id === "success") {
        return { content: [{ type: "text", text: "progress" }], details: {} };
      }
      await releaseFailures.promise;
      throw new Error("same failure");
    };
    const completed: string[] = [];
    const agent = new Agent({
      initialState: { model, tools: [tool] },
      streamFn: createTurnSequenceStream([
        ["first", "second", "success", "fourth", "fifth"].map((id) => makeCall("probe", id)),
        [{ type: "text", text: "done" }],
      ]),
    });
    setInternalBeforeToolBatch(agent, createToolLoopBatchAdmission({}));
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end") {
        completed.push(event.toolCallId);
        if (event.toolCallId === "success") {
          releaseFailures.resolve();
        }
      }
    });
    await agent.prompt("start");
    expect(completed[0]).toBe("success");
    expect(completed).toHaveLength(5);
    expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: "stop" });
  });

  it("keeps failure evidence across continue and resets it for a fresh prompt", async () => {
    const tool = makeTool("probe");
    tool.execute = async () => {
      throw new Error("same failure");
    };
    const agent = new Agent({
      initialState: { model, tools: [tool] },
      convertToLlm: config.convertToLlm,
      streamFn: createTurnSequenceStream([
        [makeCall("probe", "first")],
        [makeCall("probe", "second")],
      ]),
      afterToolOutcome: async () => ({ terminate: true }),
    });
    setInternalBeforeToolBatch(agent, createToolLoopBatchAdmission({}));
    await agent.prompt("start");
    await agent.continue();
    agent.streamFn = createTurnSequenceStream([[makeCall("probe", "third")]]);
    await agent.continue();
    expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: "error" });

    agent.streamFn = createTurnSequenceStream([[makeCall("probe", "fresh")]]);
    await agent.prompt("try again");
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "toolResult" });
    expect(agent.state.errorMessage).toBeUndefined();
  });

  it.each([
    { queue: "followUp", delivery: "active" },
    { queue: "followUp", delivery: "continue" },
    { queue: "steer", delivery: "active" },
    { queue: "steer", delivery: "continue" },
  ] as const)(
    "starts a fresh error streak for $queue through $delivery",
    async ({ queue, delivery }) => {
      const tool = makeTool("probe");
      tool.execute = async () => {
        throw new Error("same failure");
      };
      const freshInput = user("second request", 2);
      const agent = new Agent({
        initialState: { model, tools: [tool] },
        streamFn: createTurnSequenceStream([
          [makeCall("probe", "first")],
          [makeCall("probe", "second")],
          ...(queue === "steer" && delivery === "active"
            ? []
            : [[{ type: "text" as const, text: "first answer" }]]),
          [makeCall("probe", "third")],
          [{ type: "text", text: "second answer" }],
        ]),
      });
      setInternalBeforeToolBatch(agent, createToolLoopBatchAdmission({}));
      if (delivery === "active") {
        agent.subscribe((event) => {
          if (
            event.type === "message_end" &&
            event.message.role === "toolResult" &&
            event.message.toolCallId === "second"
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
      expect(agent.state.messages.filter((message) => message.role === "toolResult")).toHaveLength(
        3,
      );
      expect(agent.state.messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "second answer" }],
      });
      expect(agent.state.errorMessage).toBeUndefined();
    },
  );
});
