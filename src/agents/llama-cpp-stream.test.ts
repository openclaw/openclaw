import { describe, expect, it } from "vitest";
import { convertToChatHistory, buildAssistantMessage } from "./llama-cpp-stream.js";

describe("convertToChatHistory", () => {
  it("converts user text messages", () => {
    const messages = [{ role: "user", content: "hello" }];
    const { chatHistory } = convertToChatHistory(messages);
    expect(chatHistory).toEqual([{ type: "user", text: "hello" }]);
  });

  it("converts system messages", () => {
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hi" },
    ];
    const { chatHistory } = convertToChatHistory(messages);
    expect(chatHistory[0]).toEqual({ type: "system", text: "You are helpful." });
    expect(chatHistory[1]).toEqual({ type: "user", text: "hi" });
  });

  it("converts assistant messages with text content", () => {
    const messages = [{ role: "assistant", content: "Hello there!" }];
    const { chatHistory } = convertToChatHistory(messages);
    expect(chatHistory[0]).toEqual({ type: "model", response: ["Hello there!"] });
  });

  it("converts assistant messages with toolCall blocks", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
        ],
      },
    ];
    const { chatHistory, pendingToolCalls } = convertToChatHistory(messages);
    expect(chatHistory[0].type).toBe("model");
    expect(chatHistory[0].response).toEqual([
      "Let me check.",
      { type: "functionCall", name: "bash", params: { command: "ls" } },
    ]);
    expect(pendingToolCalls.get("call_1")).toBe("bash");
  });

  it("pairs tool results with function calls", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "/etc/hosts" } },
        ],
      },
      {
        role: "tool",
        content: "127.0.0.1 localhost",
        toolCallId: "call_1",
      },
    ];
    const { chatHistory } = convertToChatHistory(messages);
    expect(chatHistory[0].type).toBe("model");
    const functionCall = chatHistory[0].response.find(
      (r): r is { type: "functionCall"; name: string; params: unknown; result?: unknown } =>
        typeof r === "object" &&
        r !== null &&
        "type" in r &&
        r.type === "functionCall" &&
        "name" in r &&
        r.name === "read",
    );
    expect(functionCall).toBeDefined();
    expect(functionCall.result).toBe("127.0.0.1 localhost");
  });

  it("handles content parts with text extraction", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "describe " },
          { type: "text", text: "this" },
        ],
      },
    ];
    const { chatHistory } = convertToChatHistory(messages);
    expect(chatHistory[0].text).toBe("describe this");
  });

  it("handles empty messages array", () => {
    const { chatHistory } = convertToChatHistory([]);
    expect(chatHistory).toEqual([]);
  });
});

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
    const toolCall = result.content[1] as {
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };
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
    const toolCall1 = result.content[1];
    const toolCall2 = result.content[2];
    if (toolCall1.type !== "toolCall" || toolCall2.type !== "toolCall") {
      throw new Error("Expected toolCall content blocks");
    }
    expect(toolCall1.name).toBe("read");
    expect(toolCall2.name).toBe("bash");
  });
});
