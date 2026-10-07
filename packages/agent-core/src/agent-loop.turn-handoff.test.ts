// Agent Core tests cover tool calls dispatched beside a turn handoff.
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runAgentLoop } from "./agent-loop.js";
import {
  config,
  createTurnSequenceStream,
  makeCall,
  makeTool,
  user,
} from "./agent-loop.test-support.js";
import type { AgentTool } from "./types.js";

describe("agentLoop turn handoff", () => {
  it.each([
    {
      name: "a turn handoff settles",
      reason: { code: "sessions_yield", turnHandoff: true },
      delivered: ["before", "after"],
    },
    { name: "any other abort cancels", reason: new Error("user aborted"), delivered: [] },
  ])("$name the calls dispatched beside it", async ({ reason, delivered }) => {
    const controller = new AbortController();
    const handedOff = createDeferred();
    const sideEffects: string[] = [];
    const sibling = (name: string, gate?: Promise<void>): AgentTool => ({
      ...makeTool(name),
      execute: async (_id, _args, signal) => {
        await gate;
        // Final I/O checks the signal it was given, like a channel send would.
        signal?.throwIfAborted();
        sideEffects.push(name);
        return { content: [{ type: "text", text: `${name} delivered` }], details: {} };
      },
    });
    const yieldTool: AgentTool = {
      ...makeTool("yield_tool"),
      execute: async () => {
        controller.abort(reason);
        handedOff.resolve();
        return { content: [{ type: "text", text: "yielded" }], details: {} };
      },
    };
    let streamCalls = 0;
    const messages = await runAgentLoop(
      [user()],
      {
        systemPrompt: "",
        messages: [],
        // `before` is in flight when the turn ends; `after` launches only after it ended.
        tools: [sibling("before", handedOff.promise), yieldTool, sibling("after")],
      },
      { ...config, toolExecution: "parallel" },
      () => {},
      controller.signal,
      createTurnSequenceStream(
        [[makeCall("before"), makeCall("yield_tool"), makeCall("after")]],
        [],
        () => {
          streamCalls += 1;
        },
      ),
    );

    expect(streamCalls).toBe(1);
    expect(sideEffects).toEqual(delivered);
    const results = messages.filter((message) => message.role === "toolResult");
    expect(results.map((result) => [result.toolCallId, result.isError])).toEqual([
      ["before", delivered.length === 0],
      ["yield_tool", false],
      ["after", delivered.length === 0],
    ]);
    expect(messages.at(-1)).toMatchObject(
      delivered.length > 0
        ? { role: "assistant", stopReason: "aborted" }
        : { role: "custom", customType: "openclaw:turn-aborted" },
    );
  });
});
