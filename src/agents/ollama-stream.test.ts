import { describe, expect, it, vi } from "vitest";
import {
  createOllamaStreamFn,
  convertToOllamaMessages,
  buildAssistantMessage,
  parseNdjsonStream,
} from "./ollama-stream.js";

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

  it("includes tool_name from SDK toolResult messages", () => {
    const messages = [{ role: "toolResult", content: "file contents here", toolName: "read" }];
    const result = convertToOllamaMessages(messages);
    expect(result).toEqual([{ role: "tool", content: "file contents here", tool_name: "read" }]);
  });

  it("omits tool_name when not provided in toolResult", () => {
    const messages = [{ role: "toolResult", content: "output" }];
    const result = convertToOllamaMessages(messages);
    expect(result).toEqual([{ role: "tool", content: "output" }]);
    expect(result[0]).not.toHaveProperty("tool_name");
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

  it("falls back to reasoning when content is empty", () => {
    const response = {
      model: "qwen3:32b",
      created_at: "2026-01-01T00:00:00Z",
      message: {
        role: "assistant" as const,
        content: "",
        reasoning: "Reasoning output",
      },
      done: true,
    };
    const result = buildAssistantMessage(response, modelInfo);
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "Reasoning output" }]);
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

// Helper: build a ReadableStreamDefaultReader from NDJSON lines
function mockNdjsonReader(lines: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = lines.join("\n") + "\n";
  let consumed = false;
  return {
    read: async () => {
      if (consumed) {
        return { done: true as const, value: undefined };
      }
      consumed = true;
      return { done: false as const, value: encoder.encode(payload) };
    },
    releaseLock: () => {},
    cancel: async () => {},
    closed: Promise.resolve(undefined),
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

describe("parseNdjsonStream", () => {
  it("parses text-only streaming chunks", async () => {
    const reader = mockNdjsonReader([
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"Hello"},"done":false}',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":" world"},"done":false}',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":5,"eval_count":2}',
    ]);
    const chunks = [];
    for await (const chunk of parseNdjsonStream(reader)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(3);
    expect(chunks[0].message.content).toBe("Hello");
    expect(chunks[1].message.content).toBe(" world");
    expect(chunks[2].done).toBe(true);
  });

  it("parses tool_calls from intermediate chunk (not final)", async () => {
    // Ollama sends tool_calls in done:false chunk, final done:true has no tool_calls
    const reader = mockNdjsonReader([
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"bash","arguments":{"command":"ls"}}}]},"done":false}',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":10,"eval_count":5}',
    ]);
    const chunks = [];
    for await (const chunk of parseNdjsonStream(reader)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0].done).toBe(false);
    expect(chunks[0].message.tool_calls).toHaveLength(1);
    expect(chunks[0].message.tool_calls![0].function.name).toBe("bash");
    expect(chunks[1].done).toBe(true);
    expect(chunks[1].message.tool_calls).toBeUndefined();
  });

  it("accumulates tool_calls across multiple intermediate chunks", async () => {
    const reader = mockNdjsonReader([
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"read","arguments":{"path":"/tmp/a"}}}]},"done":false}',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"bash","arguments":{"command":"ls"}}}]},"done":false}',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true}',
    ]);

    // Simulate the accumulation logic from createOllamaStreamFn
    const accumulatedToolCalls: Array<{
      function: { name: string; arguments: Record<string, unknown> };
    }> = [];
    const chunks = [];
    for await (const chunk of parseNdjsonStream(reader)) {
      chunks.push(chunk);
      if (chunk.message?.tool_calls) {
        accumulatedToolCalls.push(...chunk.message.tool_calls);
      }
    }
    expect(accumulatedToolCalls).toHaveLength(2);
    expect(accumulatedToolCalls[0].function.name).toBe("read");
    expect(accumulatedToolCalls[1].function.name).toBe("bash");
    // Final done:true chunk has no tool_calls
    expect(chunks[2].message.tool_calls).toBeUndefined();
  });

  it("preserves unsafe integer tool arguments as exact strings", async () => {
    const reader = mockNdjsonReader([
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"send","arguments":{"target":1234567890123456789,"nested":{"thread":9223372036854775807}}}}]},"done":false}',
    ]);

    const chunks = [];
    for await (const chunk of parseNdjsonStream(reader)) {
      chunks.push(chunk);
    }

    const args = chunks[0]?.message.tool_calls?.[0]?.function.arguments as
      | { target?: unknown; nested?: { thread?: unknown } }
      | undefined;
    expect(args?.target).toBe("1234567890123456789");
    expect(args?.nested?.thread).toBe("9223372036854775807");
  });

  it("keeps safe integer tool arguments as numbers", async () => {
    const reader = mockNdjsonReader([
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"send","arguments":{"retries":3,"delayMs":2500}}}]},"done":false}',
    ]);

    const chunks = [];
    for await (const chunk of parseNdjsonStream(reader)) {
      chunks.push(chunk);
    }

    const args = chunks[0]?.message.tool_calls?.[0]?.function.arguments as
      | { retries?: unknown; delayMs?: unknown }
      | undefined;
    expect(args?.retries).toBe(3);
    expect(args?.delayMs).toBe(2500);
  });
});

describe("createOllamaStreamFn", () => {
  it("normalizes /v1 baseUrl and maps maxTokens + signal", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => {
      const payload = [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"ok"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
      ].join("\n");
      return new Response(`${payload}\n`, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const streamFn = createOllamaStreamFn("http://ollama-host:11434/v1/");
      const signal = new AbortController().signal;
      const stream = await streamFn(
        {
          id: "qwen3:32b",
          api: "ollama",
          provider: "custom-ollama",
          contextWindow: 131072,
        } as unknown as Parameters<typeof streamFn>[0],
        {
          messages: [{ role: "user", content: "hello" }],
        } as unknown as Parameters<typeof streamFn>[1],
        {
          maxTokens: 123,
          signal,
        } as unknown as Parameters<typeof streamFn>[2],
      );

      const events = [];
      for await (const event of stream) {
        events.push(event);
      }
      expect(events.at(-1)?.type).toBe("done");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("http://ollama-host:11434/api/chat");
      expect(requestInit.signal).toBe(signal);
      if (typeof requestInit.body !== "string") {
        throw new Error("Expected string request body");
      }

      const requestBody = JSON.parse(requestInit.body) as {
        options: { num_ctx?: number; num_predict?: number };
      };
      expect(requestBody.options.num_ctx).toBe(131072);
      expect(requestBody.options.num_predict).toBe(123);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accumulates reasoning chunks when content is empty", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => {
      const payload = [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","reasoning":"reasoned"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","reasoning":" output"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":2}',
      ].join("\n");
      return new Response(`${payload}\n`, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const streamFn = createOllamaStreamFn("http://ollama-host:11434");
      const stream = await streamFn(
        {
          id: "qwen3:32b",
          api: "ollama",
          provider: "custom-ollama",
          contextWindow: 131072,
        } as unknown as Parameters<typeof streamFn>[0],
        {
          messages: [{ role: "user", content: "hello" }],
        } as unknown as Parameters<typeof streamFn>[1],
        {} as unknown as Parameters<typeof streamFn>[2],
      );

      const events = [];
      for await (const event of stream) {
        events.push(event);
      }

      const doneEvent = events.at(-1);
      if (!doneEvent || doneEvent.type !== "done") {
        throw new Error("Expected done event");
      }

      expect(doneEvent.message.content).toEqual([{ type: "text", text: "reasoned output" }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
