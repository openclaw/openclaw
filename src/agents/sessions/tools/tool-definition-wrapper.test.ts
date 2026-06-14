import { describe, expect, it, vi } from "vitest";
import type { AgentTool } from "../../runtime/index.js";
import type { ToolDefinition } from "../extensions/types.js";
import {
  createToolDefinitionFromAgentTool,
  wrapToolDefinition,
} from "./tool-definition-wrapper.js";

describe("tool definition wrapper", () => {
  it("preserves an unreadable extension tool definition schema without crashing the wrapper", async () => {
    const execute = vi.fn(async () => ({ content: [] }));
    const prepareArguments = vi.fn((params: unknown) => params);
    const definition = {
      name: "hostile_definition",
      label: "Hostile Definition",
      description: "throws while reading parameters",
      prepareArguments,
      execute,
    } as unknown as ToolDefinition;
    Object.defineProperty(definition, "parameters", {
      get() {
        throw new Error("definition parameters exploded");
      },
    });

    const tool = wrapToolDefinition(definition, () => ({}) as never);

    expect(() => tool.parameters).toThrow("definition parameters exploded");
    expect(tool.prepareArguments).toBe(prepareArguments);
    await tool.execute("call-1", {}, undefined, undefined);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("preserves an unreadable agent tool schema without crashing definition synthesis", async () => {
    const execute = vi.fn(async () => ({ content: [] }));
    const prepareArguments = vi.fn((params: unknown) => params);
    const tool = {
      name: "hostile_agent_tool",
      label: "Hostile Agent Tool",
      description: "throws while reading parameters",
      prepareArguments,
      execute,
    } as unknown as AgentTool;
    Object.defineProperty(tool, "parameters", {
      get() {
        throw new Error("agent parameters exploded");
      },
    });

    const definition = createToolDefinitionFromAgentTool(tool);

    expect(() => definition.parameters).toThrow("agent parameters exploded");
    expect(definition.prepareArguments).toBe(prepareArguments);
    await definition.execute("call-1", {}, undefined, undefined, {} as never);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
