import { describe, expect, it } from "vitest";
import { buildAssistantMessage } from "./llama-cpp-stream.js";

describe("buildAssistantMessage", () => {
  const modelInfo = { api: "llama-cpp", provider: "llama-cpp", id: "qwen-32b" };

  it("builds text-only response", () => {
    const result = buildAssistantMessage("Hello!", undefined, modelInfo);
    expect(result.role).toBe("assistant");
    expect(result.content).toEqual([{ type: "text", text: "Hello!" }]);
    expect(result.stopReason).toBe("stop");
    expect(result.api).toBe("llama-cpp");
  });

  it("builds response with function calls", () => {
    const functionCalls = [{ functionName: "bash", params: { command: "ls -la" } }];
    const result = buildAssistantMessage("Let me check.", functionCalls, modelInfo);
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: "text", text: "Let me check." });
    expect(result.content[1].type).toBe("toolCall");
    const toolCall = result.content[1] as ToolCall;
    expect(toolCall.name).toBe("bash");
    expect(toolCall.arguments).toEqual({ command: "ls -la" });
    expect(toolCall.id).toMatch(/^llamacpp_call_[0-9a-f-]{36}$/);
  });

  it("sets all costs to zero for local models", () => {
    const result = buildAssistantMessage("ok", undefined, modelInfo);
    expect(result.usage.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    });
  });

  it("handles empty text with function calls", () => {
    const functionCalls = [{ functionName: "read", params: { path: "/tmp/file" } }];
    const result = buildAssistantMessage("", functionCalls, modelInfo);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("toolCall");
    expect(result.stopReason).toBe("toolUse");
  });

  it("handles multiple function calls", () => {
    const functionCalls = [
      { functionName: "read", params: { path: "/tmp/a" } },
      { functionName: "bash", params: { command: "ls" } },
    ];
    const result = buildAssistantMessage("Processing...", functionCalls, modelInfo);
    expect(result.content).toHaveLength(3);
    expect(result.content[0]).toEqual({ type: "text", text: "Processing..." });
    const toolCall1 = result.content[1] as ToolCall;
    const toolCall2 = result.content[2] as ToolCall;
    expect(toolCall1.name).toBe("read");
    expect(toolCall2.name).toBe("bash");
  });
});

type ToolCall = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};
