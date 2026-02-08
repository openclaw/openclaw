import { describe, expect, it } from "vitest";
import { convertToOllamaMessages, buildAssistantMessage } from "./ollama-stream.js";

describe("convertToOllamaMessages", () => {
  it("converts user text messages", () => {
    const messages = [{ role: "user", content: "hello" }];
    const result = convertToOllamaMessages(messages);
    expect(result).toEqual([{ role: "user", content: "hello" }]);
  });

  it("converts user messages with content parts", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image", data: "base64data" },
        ],
      },
    ];
    const result = convertToOllamaMessages(messages);
    expect(result).toEqual([
      { role: "user", content: "describe this", images: ["base64data"] },
    ]);
  });

  it("prepends system message when provided", () => {
    const messages = [{ role: "user", content: "hello" }];
    const result = convertToOllamaMessages(messages, "You are helpful.");
    expect(result[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(result[1]).toEqual({ role: "user", content: "hello" });
  });

  it("converts assistant messages with tool calls", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } },
        ],
      },
    ];
    const result = convertToOllamaMessages(messages);
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toBe("Let me check.");
    expect(result[0].tool_calls).toEqual([
      { function: { name: "bash", arguments: { command: "ls" } } },
    ]);
  });

  it("converts tool result messages", () => {
    const messages = [{ role: "tool", content: "file1.txt\nfile2.txt" }];
    const result = convertToOllamaMessages(messages);
    expect(result).toEqual([{ role: "tool", content: "file1.txt\nfile2.txt" }]);
  });

  it("handles empty messages array", () => {
    const result = convertToOllamaMessages([]);
    expect(result).toEqual([]);
  });
});

describe("buildAssistantMessage", () => {
  const modelInfo = { api: "ollama", provider: "ollama", id: "qwen3:32b" };

  it("builds text-only response", () => {
    const response = {
      model: "qwen3:32b",
      created_at: "2026-01-01T00:00:00Z",
      message: { role: "assistant" as const, content: "Hello!" },
      done: true,
      prompt_eval_count: 10,
      eval_count: 5,
    };
    const result = buildAssistantMessage(response, modelInfo);
    expect(result.role).toBe("assistant");
    expect(result.content).toEqual([{ type: "text", text: "Hello!" }]);
    expect(result.stopReason).toBe("stop");
    expect(result.usage.input).toBe(10);
    expect(result.usage.output).toBe(5);
    expect(result.usage.totalTokens).toBe(15);
  });

  it("builds response with tool calls", () => {
    const response = {
      model: "qwen3:32b",
      created_at: "2026-01-01T00:00:00Z",
      message: {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          { function: { name: "bash", arguments: { command: "ls -la" } } },
        ],
      },
      done: true,
      prompt_eval_count: 20,
      eval_count: 10,
    };
    const result = buildAssistantMessage(response, modelInfo);
    expect(result.stopReason).toBe("end_turn");
    expect(result.content.length).toBe(2); // empty text + tool_use
    expect(result.content[1].type).toBe("tool_use");
    const toolUse = result.content[1] as { type: "tool_use"; name: string; input: Record<string, unknown> };
    expect(toolUse.name).toBe("bash");
    expect(toolUse.input).toEqual({ command: "ls -la" });
  });

  it("sets all costs to zero for local models", () => {
    const response = {
      model: "qwen3:32b",
      created_at: "2026-01-01T00:00:00Z",
      message: { role: "assistant" as const, content: "ok" },
      done: true,
    };
    const result = buildAssistantMessage(response, modelInfo);
    expect(result.usage.cost).toEqual({
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0,
    });
  });
});
