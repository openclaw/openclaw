import { describe, expect, it } from "vitest";
import { convertMcpToolToOpenClaw, bridgeAllTools, type McpToolDescriptor } from "./tool-bridge.js";

const sampleMcpTool: McpToolDescriptor = {
  name: "remember",
  description: "Store a memory through the predictive coding write gate.",
  inputSchema: {
    type: "object",
    properties: {
      content: { type: "string", description: "The memory content" },
      tags: { type: "array", items: { type: "string" }, description: "Tags" },
      force: { type: "boolean", description: "Bypass write gate" },
    },
    required: ["content"],
  },
};

describe("convertMcpToolToOpenClaw", () => {
  it("converts an MCP tool descriptor to an OpenClaw tool definition", () => {
    const tool = convertMcpToolToOpenClaw(sampleMcpTool);
    expect(tool.name).toBe("jarvis_remember");
    expect(tool.label).toBe("Jarvis: remember");
    expect(tool.description).toContain("Store a memory");
    expect(tool.parameters).toEqual(sampleMcpTool.inputSchema);
  });

  it("prefixes tool names with jarvis_ to avoid collisions", () => {
    const tool = convertMcpToolToOpenClaw({
      name: "recall",
      description: "Recall memories.",
      inputSchema: { type: "object", properties: {}, required: [] },
    });
    expect(tool.name).toBe("jarvis_recall");
  });

  it("handles tools with no properties gracefully", () => {
    const tool = convertMcpToolToOpenClaw({
      name: "consolidate",
      description: "Run maintenance.",
      inputSchema: { type: "object" },
    });
    expect(tool.name).toBe("jarvis_consolidate");
    expect(tool.parameters.type).toBe("object");
  });
});

describe("bridgeAllTools", () => {
  it("execute proxies to MCP client.callTool and returns content", async () => {
    const mockClient = {
      callTool: async (_name: string, _args: Record<string, unknown>) => ({
        content: [{ type: "text", text: "Memory stored." }],
      }),
    };
    const tools = bridgeAllTools([sampleMcpTool], mockClient as any);
    expect(tools).toHaveLength(1);
    const result = await tools[0].execute("call-1", { content: "test" });
    expect(result.content[0].text).toBe("Memory stored.");
  });

  it("execute returns error content when MCP client throws", async () => {
    const mockClient = {
      callTool: async () => {
        throw new Error("Connection lost");
      },
    };
    const warns: string[] = [];
    const tools = bridgeAllTools([sampleMcpTool], mockClient as any, {
      warn: (msg: string) => warns.push(msg),
    });
    const result = await tools[0].execute("call-2", { content: "test" });
    expect(result.content[0].text).toContain("Connection lost");
    expect(result.details?.error).toBe(true);
    expect(warns.length).toBe(1);
  });

  it("execute handles JSON string results from MCP", async () => {
    const mockClient = {
      callTool: async () => '{"status": "ok"}',
    };
    const tools = bridgeAllTools([sampleMcpTool], mockClient as any);
    const result = await tools[0].execute("call-3", {});
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("ok");
  });
});
