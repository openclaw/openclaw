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
    expect(result).toEqual([{ role: "user", content: "describe this", images: ["base64data"] }]);
  });

  it("prepends system message when provided", () => {
    const messages = [{ role: "user", content: "hello" }];
    const result = convertToOllamaMessages(messages, "You are helpful.");
    expect(result[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(result[1]).toEqual({ role: "user", content: "hello" });
  });

  it("converts assistant messages with toolCall content blocks", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
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

  it("converts tool result messages with 'tool' role", () => {
    const messages = [{ role: "tool", content: "file1.txt\nfile2.txt" }];
    const result = convertToOllamaMessages(messages);
    expect(result).toEqual([{ role: "tool", content: "file1.txt\nfile2.txt" }]);
  });

  it("converts SDK 'toolResult' role to Ollama 'tool' role", () => {
    const messages = [{ role: "toolResult", content: "command output here" }];
    const result = convertToOllamaMessages(messages);
    expect(result).toEqual([{ role: "tool", content: "command output here" }]);
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
        tool_calls: [{ function: { name: "bash", arguments: { command: "ls -la" } } }],
      },
      done: true,
      prompt_eval_count: 20,
      eval_count: 10,
    };
    const result = buildAssistantMessage(response, modelInfo);
    expect(result.stopReason).toBe("toolUse");
    expect(result.content.length).toBe(1); // toolCall only (empty content is skipped)
    expect(result.content[0].type).toBe("toolCall");
    const toolCall = result.content[0] as {
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };
    expect(toolCall.name).toBe("bash");
    expect(toolCall.arguments).toEqual({ command: "ls -la" });
    expect(toolCall.id).toMatch(/^ollama_call_[0-9a-f-]{36}$/);
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
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    });
  });
});
