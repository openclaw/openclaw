import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import { describe, expect, it } from "vitest";
import {
  captureAgent,
  createTurnSequenceStream,
  finishMessageStream,
  makeAssistantMessage,
  makeCall,
  makeTool,
  startToolCalls,
  user,
} from "./agent-loop.test-support.js";
import { setInternalToolRepeatPolicy } from "./internal-hooks.js";
import { TOOL_REPEAT_LIMIT_CODE } from "./tool-repeat-guard.js";
import type { AgentTool } from "./types.js";

const names = ["exec", "read", "write"];

function rotation(count: number, prefix = "call") {
  return Array.from({ length: Math.ceil(count / names.length) }, (_, cycle) =>
    names.map((name, index) => [makeCall(name, `${prefix}-${cycle * names.length + index}`)]),
  )
    .flat()
    .slice(0, count);
}

describe("stable tool rotations", () => {
  it.each(["stable", "progress", "disabled"] as const)(
    "bounds a three-tool rotation without stopping progress or disabled runs: %s",
    async (kind) => {
      let executed = 0;
      const tools = names.map((name): AgentTool => ({
        ...makeTool(name),
        execute: async () => {
          executed += 1;
          return {
            content: [{ type: "text" as const, text: kind === "progress" ? `${executed}` : name }],
            details: { durationMs: executed },
          };
        },
      }));
      const turns = rotation(60);
      const { agent } = captureAgent(tools, {}, [...turns, [{ type: "text", text: "done" }]]);
      setInternalToolRepeatPolicy(agent, { enabled: kind !== "disabled" });

      await agent.prompt("Complete this workflow.");

      if (kind === "stable") {
        expect(executed).toBe(30);
        expect(agent.state.messages.at(-1)).toMatchObject({
          role: "assistant",
          stopReason: "error",
          errorCode: TOOL_REPEAT_LIMIT_CODE,
        });
      } else {
        expect(executed).toBe(60);
        expect(agent.state.messages.at(-1)).toMatchObject({
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "done" }],
        });
      }
    },
  );

  it("allows a changed recovery action before stopping a second stable loop", async () => {
    const executed: string[] = [];
    const { agent } = captureAgent(
      [...names, "recover"].map((name) => makeTool(name, executed)),
      {},
      [
        ...rotation(31, "first"),
        [makeCall("recover", "changed-action")],
        ...rotation(31, "second"),
        [{ type: "text", text: "done" }],
      ],
    );

    await agent.prompt("Complete this workflow.");

    expect(executed.filter((name) => name === "recover")).toHaveLength(1);
    expect(executed.filter((name) => name !== "recover")).toHaveLength(60);
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorCode: TOOL_REPEAT_LIMIT_CODE,
    });
  });

  it("does not inherit stable outcomes from a previous accepted input", async () => {
    const executed: string[] = [];
    const calls = rotation(15);
    const answer = [{ type: "text" as const, text: "done" }];
    const { agent } = captureAgent(
      names.map((name) => makeTool(name, executed)),
      {},
      [...calls, answer, ...calls, answer],
    );

    await agent.prompt("First workflow.");
    await agent.prompt("Second workflow.");

    expect(executed).toHaveLength(30);
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
  });

  it.each(["running", "repeatable"] as const)(
    "allows a rotation containing %s work",
    async (kind) => {
      const executed: string[] = [];
      const tools = names.map((name): AgentTool => ({
        ...makeTool(name, executed),
        ...(name === "read" && kind === "repeatable" ? { repeatable: true } : {}),
        execute: async () => {
          executed.push(name);
          return { content: [{ type: "text" as const, text: name }], details: { status: kind } };
        },
      }));
      const { agent } = captureAgent(tools, {}, [
        ...rotation(60),
        [{ type: "text", text: "done" }],
      ]);

      await agent.prompt("Complete this workflow.");

      expect(executed).toHaveLength(60);
      expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
    },
  );

  it.each(["first", "last"] as const)(
    "blocks every unstarted sibling when the critical call is %s",
    async (position) => {
      const executed: string[] = [];
      const { agent } = captureAgent(
        [...names, "recover"].map((name) => makeTool(name, executed)),
        {},
        [
          ...rotation(30),
          position === "first"
            ? [makeCall("exec", "blocked-rotation"), makeCall("recover", "blocked-sibling")]
            : [makeCall("recover", "blocked-sibling"), makeCall("exec", "blocked-rotation")],
          [makeCall("recover", "recovery")],
          [{ type: "text", text: "done" }],
        ],
      );

      await agent.prompt("Complete this workflow.");

      expect(executed).toHaveLength(31);
      expect(executed.filter((name) => name === "recover")).toHaveLength(1);
      expect(agent.state.messages).toContainEqual(
        expect.objectContaining({
          role: "toolResult",
          toolCallId: "blocked-sibling",
          isError: true,
          details: expect.objectContaining({ deniedReason: TOOL_REPEAT_LIMIT_CODE }),
        }),
      );
      expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
    },
  );

  it.each(["parallel", "sequential"] as const)(
    "commits a correction accepted at the terminal loop boundary in %s mode",
    async (toolExecution) => {
      const executed: string[] = [];
      const correction = user("Use the corrected plan.");
      const { agent } = captureAgent(
        names.map((name) => makeTool(name, executed)),
        { toolExecution },
        [...rotation(32), ...rotation(15, "after-correction"), [{ type: "text", text: "done" }]],
      );
      let sent = false;
      setInternalToolRepeatPolicy(agent, {
        enabled: true,
        onVerdict: (verdict) => {
          if (!sent && verdict.noProgress && verdict.kind === "stop") {
            sent = true;
            agent.steer(correction);
          }
        },
      });

      await agent.prompt("Complete this workflow.");

      expect(agent.state.messages).toContainEqual(correction);
      expect(executed).toHaveLength(45);
      expect(agent.state.messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "done" }],
      });
    },
  );

  it("stops active sampling when an async rotation reaches its terminal verdict", async () => {
    const executed: string[] = [];
    const initial = createTurnSequenceStream(rotation(31));
    let requests = 0;
    let samplingAborted = false;
    let finishCritical: () => void = () => {
      throw new Error("Critical stream is not active.");
    };
    const { agent } = captureAgent(
      names.map((name) => makeTool(name, executed)),
      {
        streamFn: (...args) => {
          if (requests++ < 31) {
            return initial(...args);
          }
          const response = createAssistantMessageEventStream();
          const calls = [{ ...makeCall("read", "streamed-stop"), async: true as const }];
          finishCritical = () => {
            samplingAborted = args[2]?.signal?.aborted ?? false;
            finishMessageStream(response, makeAssistantMessage(calls));
          };
          queueMicrotask(() => startToolCalls(response, calls));
          return response;
        },
      },
    );
    setInternalToolRepeatPolicy(agent, {
      enabled: true,
      onVerdict: (verdict) => {
        if (verdict.noProgress && verdict.kind === "stop") {
          queueMicrotask(finishCritical);
        }
      },
    });

    await agent.prompt("Complete this workflow.");

    expect(samplingAborted).toBe(true);
    expect(executed).toHaveLength(30);
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorCode: TOOL_REPEAT_LIMIT_CODE,
    });
  });
});
