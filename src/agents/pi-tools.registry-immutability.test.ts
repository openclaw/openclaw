import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { splitSdkTools } from "./pi-embedded-runner/tool-split.js";
import { toClientToolDefinitions, toToolDefinitions } from "./pi-tool-definition-adapter.js";

function createStubTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `stub-${name}`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }) as AgentToolResult<unknown>,
  };
}

describe("tool registry immutability (#27205)", () => {
  it("splitSdkTools returns frozen arrays", () => {
    const tools = [createStubTool("exec"), createStubTool("read")];
    const { builtInTools, customTools } = splitSdkTools({
      tools,
      sandboxEnabled: false,
    });
    expect(Object.isFrozen(builtInTools)).toBe(true);
    expect(Object.isFrozen(customTools)).toBe(true);
  });

  it("toToolDefinitions snapshots the source array", () => {
    const tools = [createStubTool("exec"), createStubTool("read"), createStubTool("write")];
    const defs = toToolDefinitions(tools);
    expect(defs).toHaveLength(3);

    // Mutating the source array after conversion must not affect the definitions
    tools.length = 0;
    expect(defs).toHaveLength(3);
    expect(defs.map((d) => d.name)).toEqual(["exec", "read", "write"]);
  });

  it("toToolDefinitions definitions remain resolvable after source mutation", async () => {
    const tools = [createStubTool("exec"), createStubTool("read")];
    const defs = toToolDefinitions(tools);

    // Mutate source — definitions must still execute successfully
    tools.splice(0, tools.length);

    for (const def of defs) {
      // oxlint-disable-next-line typescript/no-explicit-any
      const result = await def.execute("call-1", {}, undefined, undefined, undefined as any);
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    }
  });

  it("toClientToolDefinitions snapshots the source array", () => {
    const clientTools = [
      {
        type: "function" as const,
        function: {
          name: "custom_tool",
          description: "test",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const defs = toClientToolDefinitions(clientTools);
    expect(defs).toHaveLength(1);

    // Mutating source after conversion must not affect output
    clientTools.length = 0;
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("custom_tool");
  });

  it("frozen registry survives concurrent mutation attempts", () => {
    const tools = [
      createStubTool("exec"),
      createStubTool("read"),
      createStubTool("web_search"),
      createStubTool("message"),
    ];
    const { customTools } = splitSdkTools({ tools, sandboxEnabled: false });

    // Simulating what a concurrent code path might try to do
    expect(() => {
      (customTools as unknown[]).push(createStubTool("injected"));
    }).toThrow();
    expect(() => {
      (customTools as unknown[]).length = 0;
    }).toThrow();
    expect(() => {
      (customTools as unknown[]).splice(0, 1);
    }).toThrow();

    // All original tools remain intact
    expect(customTools).toHaveLength(4);
    expect(customTools.map((d) => d.name)).toEqual(["exec", "read", "web_search", "message"]);
  });

  it("4+ consecutive tool calls all resolve after async gap (regression #27205)", async () => {
    const toolNames = ["exec", "web_search", "read", "exec", "message"];
    const tools = toolNames.map(createStubTool);
    const defs = toToolDefinitions(tools);
    const defMap = new Map(defs.map((d) => [d.name, d]));

    // Simulate sequential tool calls with async gaps between them
    const callSequence = ["exec", "web_search", "read", "exec", "message"];
    for (let i = 0; i < callSequence.length; i++) {
      const name = callSequence[i];
      const tool = defMap.get(name);
      expect(tool).toBeDefined();

      // Simulate async gap (like a network call during web_search)
      await new Promise((resolve) => setTimeout(resolve, 1));

      // oxlint-disable-next-line typescript/no-explicit-any
      const result = await tool!.execute(`call-${i}`, {}, undefined, undefined, undefined as any);
      expect(result).toBeDefined();

      // Verify ALL tools are still resolvable after each call
      for (const expectedName of callSequence) {
        expect(defMap.get(expectedName)).toBeDefined();
      }
    }
  });
});
