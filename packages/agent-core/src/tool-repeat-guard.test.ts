// Agent Core tests cover the arguments-only tool repeat guard.
import { describe, expect, it } from "vitest";
import { captureAgent, makeCall, makeTool } from "./agent-loop.test-support.js";
import { setInternalToolRepeatPolicy } from "./internal-hooks.js";
import {
  TOOL_REPEAT_LIMIT_CODE,
  TOOL_REPEAT_NOTE_AT,
  TOOL_REPEAT_STOP_AT,
  createToolRepeatState,
  observeToolRepeat,
  type ToolRepeatVerdict,
} from "./tool-repeat-guard.js";
import type { AgentTool, AgentToolCall } from "./types.js";

function call(name: string, args: Record<string, unknown> = {}, id = name): AgentToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

function turns(count: number, toolCall: (index: number) => AgentToolCall) {
  return Array.from({ length: count }, (_, index) => [toolCall(index)]);
}

const answer = [{ type: "text" as const, text: "done" }];

describe("observeToolRepeat", () => {
  it("notes the third identical call and stops at the twentieth", () => {
    const state = createToolRepeatState();
    const tool = makeTool("read");
    const verdicts = Array.from({ length: TOOL_REPEAT_STOP_AT }, (_, index) =>
      observeToolRepeat(state, call("read", { path: "a", line: 1 }, `c${index}`), tool),
    );
    expect(
      verdicts.flatMap((verdict, index) => (verdict ? [[index + 1, verdict.kind]] : [])),
    ).toEqual([
      [TOOL_REPEAT_NOTE_AT, "note"],
      [TOOL_REPEAT_STOP_AT, "stop"],
    ]);
  });

  it("compares canonical arguments, not key order or outcomes", () => {
    const state = createToolRepeatState();
    const tool = makeTool("read");
    observeToolRepeat(state, call("read", { path: "a", line: 1 }), tool);
    observeToolRepeat(state, call("read", { line: 1, path: "a" }), tool);
    expect(observeToolRepeat(state, call("read", { path: "a", line: 1 }), tool)).toMatchObject({
      kind: "note",
      count: 3,
    });
    expect(observeToolRepeat(state, call("read", { path: "b", line: 1 }), tool)).toBeUndefined();
    expect(state.count).toBe(1);
  });

  it("keys an unknown tool by name, so churned arguments still repeat", () => {
    const state = createToolRepeatState();
    const verdicts = [1, 2, 3].map((n) =>
      observeToolRepeat(state, call("ghost", { n }), undefined),
    );
    expect(verdicts.at(-1)).toMatchObject({ kind: "note", toolName: "ghost", count: 3 });
  });

  it("skips tools that declare themselves repeatable and resets the streak", () => {
    const state = createToolRepeatState();
    const read = makeTool("read");
    const poll: AgentTool = {
      ...makeTool("process"),
      repeatable: { actions: ["poll"] },
    };
    observeToolRepeat(state, call("read"), read);
    observeToolRepeat(state, call("read"), read);
    for (let index = 0; index < 30; index++) {
      expect(observeToolRepeat(state, call("process", { action: "poll" }), poll)).toBeUndefined();
    }
    expect(observeToolRepeat(state, call("read"), read)).toBeUndefined();
    expect(observeToolRepeat(state, call("process", { action: "kill" }), poll)).toBeUndefined();
    expect(state.count).toBe(1);
  });
});

describe("agent loop repeat guard", () => {
  it("adds one redirect note to the third identical call's result and keeps running", async () => {
    const executed: string[] = [];
    const verdicts: ToolRepeatVerdict[] = [];
    const hookResults: number[] = [];
    const { agent, requests } = captureAgent(
      [makeTool("read", executed)],
      {
        // Hooks see the raw outcome; the note is appended after them.
        afterToolOutcome: async ({ result }) => void hookResults.push(result.content.length),
      },
      [...turns(4, (index) => makeCall("read", `read-${index}`)), answer],
    );
    setInternalToolRepeatPolicy(agent, { enabled: true, onVerdict: (v) => verdicts.push(v) });

    await agent.prompt("start");

    expect(executed).toHaveLength(4);
    expect(hookResults).toEqual([1, 1, 1, 1]);
    const results = agent.state.messages.filter((message) => message.role === "toolResult");
    expect(results.map((message) => message.content.length)).toEqual([1, 1, 2, 1]);
    expect(results[2]?.content[1]).toEqual({
      type: "text",
      text: expect.stringContaining("You called read with the same arguments 3 times in a row"),
    });
    expect(requests).toHaveLength(5);
    expect(verdicts).toEqual([{ kind: "note", toolCallId: "read-2", toolName: "read", count: 3 }]);
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
  });

  it("ends the turn at the twentieth identical call with tool_repeat_limit, without running it", async () => {
    const executed: string[] = [];
    const { agent, requests } = captureAgent([makeTool("read", executed)], {}, [
      ...turns(TOOL_REPEAT_STOP_AT, (index) => makeCall("read", `read-${index}`)),
      answer,
    ]);

    await agent.prompt("start");

    expect(executed).toHaveLength(TOOL_REPEAT_STOP_AT - 1);
    expect(requests).toHaveLength(TOOL_REPEAT_STOP_AT);
    const results = agent.state.messages.filter((message) => message.role === "toolResult");
    expect(results.at(-1)).toMatchObject({
      toolCallId: `read-${TOOL_REPEAT_STOP_AT - 1}`,
      isError: true,
      details: { status: "blocked", deniedReason: TOOL_REPEAT_LIMIT_CODE },
    });
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorCode: TOOL_REPEAT_LIMIT_CODE,
      content: [
        {
          type: "text",
          text: "OpenClaw stopped this turn: the model called read with the same arguments 20 times in a row. Send a new message to continue.",
        },
      ],
    });
  });

  it("keeps a repeatable tool out of the count", async () => {
    const executed: string[] = [];
    const wait: AgentTool = { ...makeTool("wait", executed), repeatable: true };
    const { agent } = captureAgent([wait], {}, [
      ...turns(TOOL_REPEAT_STOP_AT + 5, (index) => makeCall("wait", `wait-${index}`)),
      answer,
    ]);

    await agent.prompt("start");

    expect(executed).toHaveLength(TOOL_REPEAT_STOP_AT + 5);
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
  });

  it("is off when the host disables it", async () => {
    const executed: string[] = [];
    const { agent } = captureAgent([makeTool("read", executed)], {}, [
      ...turns(TOOL_REPEAT_STOP_AT + 1, (index) => makeCall("read", `read-${index}`)),
      answer,
    ]);
    setInternalToolRepeatPolicy(agent, { enabled: false });

    await agent.prompt("start");

    expect(executed).toHaveLength(TOOL_REPEAT_STOP_AT + 1);
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
  });

  it("resets the streak when new user input is committed", async () => {
    const executed: string[] = [];
    const { agent } = captureAgent([makeTool("read", executed)], {}, [
      ...turns(2, (index) => makeCall("read", `first-${index}`)),
      answer,
      ...turns(2, (index) => makeCall("read", `second-${index}`)),
      answer,
    ]);

    await agent.prompt("first");
    await agent.prompt("second");

    const results = agent.state.messages.filter((message) => message.role === "toolResult");
    expect(results.map((message) => message.content.length)).toEqual([1, 1, 1, 1]);
  });
});

// Regression: before this guard, three identical failing calls quarantined the action and
// the next identical call ended the turn with no model answer.
describe("repeated identical failures", () => {
  it("lets a run with repeated identical failing calls reach the model's final answer", async () => {
    let failures = 0;
    const probe: AgentTool = {
      ...makeTool("probe"),
      execute: async () => {
        failures += 1;
        throw new Error("same failure");
      },
    };
    const { agent } = captureAgent([probe], {}, [
      ...turns(4, (index) => makeCall("probe", `probe-${index}`)),
      answer,
    ]);

    await agent.prompt("start");

    expect(failures).toBe(4);
    const results = agent.state.messages.filter((message) => message.role === "toolResult");
    expect(results[2]?.content.at(-1)).toMatchObject({
      text: expect.stringContaining("same arguments 3 times in a row"),
    });
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "stop",
      content: answer,
    });
  });
});
