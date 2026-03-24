import { describe, expect, it } from "vitest";
import { convertMcpToolToOpenClaw, type McpToolDescriptor } from "./tool-bridge.js";

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
