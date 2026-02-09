import { describe, expect, it } from "vitest";
import { sanitizeBedrockToolName, sanitizeToolNamesForBedrock } from "./bedrock.js";

describe("sanitizeBedrockToolName", () => {
  it("keeps valid names unchanged", () => {
    expect(sanitizeBedrockToolName("memory_search")).toBe("memory_search");
    expect(sanitizeBedrockToolName("web-fetch")).toBe("web-fetch");
    expect(sanitizeBedrockToolName("Read")).toBe("Read");
  });

  it("replaces invalid characters with underscore", () => {
    expect(sanitizeBedrockToolName("tool.name")).toBe("tool_name");
    expect(sanitizeBedrockToolName("tool name")).toBe("tool_name");
    expect(sanitizeBedrockToolName("tool@name!")).toBe("tool_name_");
  });

  it("truncates names exceeding 64 characters", () => {
    const longName = "a".repeat(100);
    expect(sanitizeBedrockToolName(longName)).toHaveLength(64);
  });

  it("handles combined invalid chars and long names", () => {
    const longInvalid = "tool.with.dots.".repeat(10);
    const result = sanitizeBedrockToolName(longInvalid);
    expect(result).toHaveLength(64);
    expect(result).not.toMatch(/\./);
  });
});

describe("sanitizeToolNamesForBedrock", () => {
  const makeTool = (name: string) => ({
    name,
    description: "test",
    parameters: {},
    execute: async () => ({}),
  });

  it("skips non-bedrock providers", () => {
    const tools = [makeTool("tool.name")];
    const result = sanitizeToolNamesForBedrock({
      tools,
      provider: "anthropic",
    });
    expect(result[0].name).toBe("tool.name");
  });

  it("sanitizes for amazon-bedrock provider", () => {
    const tools = [makeTool("tool.name")];
    const result = sanitizeToolNamesForBedrock({
      tools,
      provider: "amazon-bedrock",
    });
    expect(result[0].name).toBe("tool_name");
  });

  it("sanitizes for bedrock-converse-stream model API", () => {
    const tools = [makeTool("tool.name")];
    const result = sanitizeToolNamesForBedrock({
      tools,
      provider: "openai",
      modelApi: "bedrock-converse-stream",
    });
    expect(result[0].name).toBe("tool_name");
  });

  it("does not create new objects for already-valid names", () => {
    const tools = [makeTool("valid_name")];
    const result = sanitizeToolNamesForBedrock({
      tools,
      provider: "amazon-bedrock",
    });
    expect(result[0]).toBe(tools[0]);
  });
});
