import { expect, it, vi } from "vitest";
import { ToolArgumentValidationError } from "../../../src/plugin-sdk/tool-plugin.js";
import {
  captureAgentLoop,
  collectEvents,
  config,
  createTurnSequenceStream,
  makeCall,
  makeTool,
  user,
} from "./agent-loop.test-support.js";

it.each(["parallel", "sequential"] as const)(
  "classifies typed preparation rejections before %s execution",
  async (executionMode) => {
    const executed: string[] = [];
    const afterToolOutcome = vi.fn();
    const tool = {
      ...makeTool("edit", executed),
      executionMode,
      prepareArguments() {
        throw new ToolArgumentValidationError("payload must be a dictionary");
      },
    };
    const events = await collectEvents(
      captureAgentLoop(
        [user()],
        { systemPrompt: "", messages: [], tools: [tool] },
        { ...config, afterToolOutcome },
        undefined,
        createTurnSequenceStream([[makeCall("edit")], [{ type: "text", text: "done" }]]),
      ),
    );
    expect(executed).toEqual([]);
    expect(events.find((event) => event.type === "tool_execution_end")).toMatchObject({
      executionStarted: false,
      isError: true,
      errorKind: "argument-validation",
      result: { content: [{ type: "text", text: "payload must be a dictionary" }] },
    });
    expect(afterToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        executionStarted: false,
        isError: true,
        errorKind: "argument-validation",
        args: {},
      }),
      undefined,
    );
  },
);

it.each(["generic preparation", "typed execution"] as const)(
  "does not classify %s failures as argument validation",
  async (phase) => {
    const executed: string[] = [];
    const afterToolOutcome = vi.fn();
    const failure =
      phase === "typed execution"
        ? new ToolArgumentValidationError("implementation failed")
        : Object.assign(new Error("implementation failed"), {
            name: "ToolArgumentValidationError",
          });
    const tool = makeTool("edit", executed);
    if (phase === "generic preparation") {
      tool.prepareArguments = () => {
        throw failure;
      };
    } else {
      tool.execute = async () => {
        executed.push("edit");
        throw failure;
      };
    }
    const events = await collectEvents(
      captureAgentLoop(
        [user()],
        { systemPrompt: "", messages: [], tools: [tool] },
        { ...config, afterToolOutcome },
        undefined,
        createTurnSequenceStream([[makeCall("edit")], [{ type: "text", text: "done" }]]),
      ),
    );
    expect(executed).toEqual(phase === "typed execution" ? ["edit"] : []);
    const end = events.find((event) => event.type === "tool_execution_end");
    expect(end).toMatchObject({ isError: true, executionStarted: phase === "typed execution" });
    expect(end).not.toHaveProperty("errorKind");
    expect(afterToolOutcome.mock.calls[0]?.[0]).not.toHaveProperty("errorKind");
  },
);
