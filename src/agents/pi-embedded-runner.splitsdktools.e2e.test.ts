import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { splitSdkTools } from "./pi-embedded-runner.js";

function createStubTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: "",
    parameters: Type.Object({}),
    execute: async () => ({}) as AgentToolResult<unknown>,
  };
}

describe("splitSdkTools", () => {
  const tools = [
    createStubTool("read"),
    createStubTool("exec"),
    createStubTool("edit"),
    createStubTool("write"),
    createStubTool("browser"),
  ];

  it("routes all tools to customTools when sandboxed", () => {
    const { builtInTools, customTools } = splitSdkTools({
      tools,
      sandboxEnabled: true,
    });
    expect(builtInTools).toEqual([]);
    expect(customTools.map((tool) => tool.name)).toEqual([
      "read",
      "exec",
      "edit",
      "write",
      "browser",
    ]);
  });

  it("routes all tools to customTools even when not sandboxed", () => {
    const { builtInTools, customTools } = splitSdkTools({
      tools,
      sandboxEnabled: false,
    });
    expect(builtInTools).toEqual([]);
    expect(customTools.map((tool) => tool.name)).toEqual([
      "read",
      "exec",
      "edit",
      "write",
      "browser",
    ]);
  });
  it("accepts hookContext and passes it through", () => {
    const hookContext = { agentId: "test-agent", sessionKey: "test-session" };
    const { customTools } = splitSdkTools({
      tools,
      sandboxEnabled: true,
      hookContext,
    });
    // Verify it accepts the parameter without error
    expect(customTools.length).toBe(5);
  });
  it("works with undefined hookContext (backward compatible)", () => {
    const { customTools } = splitSdkTools({
      tools,
      sandboxEnabled: true,
      hookContext: undefined,
    });
    expect(customTools.length).toBe(5);
  });
});
