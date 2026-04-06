import { describe, expect, it } from "vitest";
import { bridgeTool, bridgeTools } from "./tool-bridge.js";

function fakeAgentTool(
  overrides: Partial<{
    name: string;
    description: string;
    label: string;
    parameters: Record<string, unknown>;
    execute: (
      id: string,
      params: unknown,
    ) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
  }> = {},
) {
  return {
    name: overrides.name ?? "test_tool",
    description: overrides.description ?? "A test tool",
    label: overrides.label ?? "Test Tool",
    parameters: overrides.parameters ?? {
      type: "object",
      properties: { input: { type: "string" } },
    },
    execute:
      overrides.execute ??
      (async () => ({
        content: [{ type: "text" as const, text: "tool result" }],
        details: {},
      })),
  };
}

describe("bridgeTool", () => {
  it("converts name, description, and parameters", () => {
    const agentTool = fakeAgentTool({ name: "message", description: "Send a message" });
    const sdkTool = bridgeTool(agentTool as never);

    expect(sdkTool.name).toBe("message");
    expect(sdkTool.description).toBe("Send a message");
    expect(sdkTool.parameters).toEqual({
      type: "object",
      properties: { input: { type: "string" } },
    });
  });

  it("handler calls execute and returns ToolResultObject", async () => {
    const agentTool = fakeAgentTool({
      execute: async () => ({
        content: [
          { type: "text" as const, text: "Hello " },
          { type: "text" as const, text: "world" },
        ],
        details: {},
      }),
    });
    const sdkTool = bridgeTool(agentTool as never);
    const result = await sdkTool.handler(
      {},
      { sessionId: "s1", toolCallId: "tc1", toolName: "test_tool", arguments: {} },
    );

    expect(result).toEqual({ textResultForLlm: "Hello \nworld", resultType: "success" });
  });

  it("returns failure ToolResultObject on execute error", async () => {
    const agentTool = fakeAgentTool({
      execute: async () => {
        throw new Error("tool broke");
      },
    });
    const sdkTool = bridgeTool(agentTool as never);
    const result = await sdkTool.handler(
      {},
      { sessionId: "s1", toolCallId: "tc1", toolName: "test_tool", arguments: {} },
    );

    expect(result).toEqual({ textResultForLlm: "", resultType: "failure", error: "tool broke" });
  });

  it("returns OK when execute returns no text", async () => {
    const agentTool = fakeAgentTool({
      execute: async () => ({
        content: [],
        details: {},
      }),
    });
    const sdkTool = bridgeTool(agentTool as never);
    const result = await sdkTool.handler(
      {},
      { sessionId: "s1", toolCallId: "tc1", toolName: "test_tool", arguments: {} },
    );

    expect(result).toEqual({ textResultForLlm: "OK", resultType: "success" });
  });
});

describe("bridgeTools", () => {
  it("filters out runtime built-in tools", () => {
    const tools = [
      fakeAgentTool({ name: "bash" }),
      fakeAgentTool({ name: "read_file" }),
      fakeAgentTool({ name: "message" }),
      fakeAgentTool({ name: "cron" }),
    ];
    const sdkTools = bridgeTools(tools as never[]);

    expect(sdkTools.map((t) => t.name)).toEqual(["message", "cron"]);
  });

  it("returns empty array for empty input", () => {
    expect(bridgeTools([])).toEqual([]);
  });
});
