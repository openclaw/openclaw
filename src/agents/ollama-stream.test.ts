import { describe, expect, it, vi } from "vitest";
import {
  createConfiguredOllamaStreamFn,
  createOllamaStreamFn,
  convertToOllamaMessages,
  buildAssistantMessage,
  parseNdjsonStream,
  resolveOllamaBaseUrlForRun,
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

  it("drops thinking-only output when content is empty", () => {
    const response = {
      model: "qwen3:32b",
      created_at: "2026-01-01T00:00:00Z",
      message: {
        role: "assistant" as const,
        content: "",
        thinking: "Thinking output",
      },
      done: true,
    };
    const result = buildAssistantMessage(response, modelInfo);
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([]);
  });

  it("drops reasoning-only output when content and thinking are empty", () => {
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
    expect(result.content).toEqual([]);
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

async function expectDoneEventContent(lines: string[], expectedContent: unknown) {
  await withMockNdjsonFetch(lines, async () => {
    const stream = await createOllamaTestStream({ baseUrl: "http://ollama-host:11434" });
    const events = await collectStreamEvents(stream);

    const doneEvent = events.at(-1);
    if (!doneEvent || doneEvent.type !== "done") {
      throw new Error("Expected done event");
    }

    expect(doneEvent.message.content).toEqual(expectedContent);
  });
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

async function withMockNdjsonFetch(
  lines: string[],
  run: (fetchMock: ReturnType<typeof vi.fn>) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn(async () => {
    const payload = lines.join("\n");
    return new Response(`${payload}\n`, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  try {
    await run(fetchMock);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function createOllamaTestStream(params: {
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  options?: {
    apiKey?: string;
    maxTokens?: number;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  };
}) {
  const streamFn = createOllamaStreamFn(params.baseUrl, params.defaultHeaders);
  return streamFn(
    {
      id: "qwen3:32b",
      api: "ollama",
      provider: "custom-ollama",
      contextWindow: 131072,
    } as unknown as Parameters<typeof streamFn>[0],
    {
      messages: [{ role: "user", content: "hello" }],
    } as unknown as Parameters<typeof streamFn>[1],
    (params.options ?? {}) as unknown as Parameters<typeof streamFn>[2],
  );
}

async function collectStreamEvents<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

// Helper to build a minimal context with tools for fallback tests
function makeContextWithTools() {
  return {
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "bash", description: "run bash", parameters: {} }],
  };
}

describe("createOllamaStreamFn - tools fallback", () => {
  const successNdjson =
    [
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"hi"},"done":false}',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
    ].join("\n") + "\n";

  it("retries without tools on 400 tool-unsupported error and produces done event", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        // Simulate Ollama's 400 rejection for models that don't support tools
        return new Response('model "gemma3:1b" does not support tools', { status: 400 });
      }
      return new Response(successNdjson, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const streamFn = createOllamaStreamFn("http://localhost:11434");
      const stream = await streamFn(
        {
          id: "gemma3:1b",
          api: "ollama",
          provider: "custom-ollama",
          contextWindow: 65536,
        } as unknown as Parameters<typeof streamFn>[0],
        makeContextWithTools() as unknown as Parameters<typeof streamFn>[1],
        {} as unknown as Parameters<typeof streamFn>[2],
      );

      const events = await collectStreamEvents(stream);

      expect(fetchMock).toHaveBeenCalledTimes(2);

      // First call must include tools in the body
      const [, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      const firstBody = JSON.parse(firstInit.body as string) as { tools?: unknown };
      expect(firstBody.tools).toBeDefined();

      // Second (retry) call must omit tools
      const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      const secondBody = JSON.parse(secondInit.body as string) as { tools?: unknown };
      expect(secondBody.tools).toBeUndefined();

      // Stream must end with a done event (not error)
      expect(events.at(-1)?.type).toBe("done");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries without tools when Ollama returns JSON-structured 400 error", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        // JSON-structured error payload (Ollama can return errors in this format)
        return new Response(JSON.stringify({ error: 'model "gemma3:1b" does not support tools' }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(successNdjson, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const streamFn = createOllamaStreamFn("http://localhost:11434");
      const stream = await streamFn(
        {
          id: "gemma3:1b",
          api: "ollama",
          provider: "custom-ollama",
          contextWindow: 65536,
        } as unknown as Parameters<typeof streamFn>[0],
        makeContextWithTools() as unknown as Parameters<typeof streamFn>[1],
        {} as unknown as Parameters<typeof streamFn>[2],
      );

      const events = await collectStreamEvents(stream);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Second call must omit tools
      const [, secondInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
      const secondBody = JSON.parse(secondInit.body as string) as { tools?: unknown };
      expect(secondBody.tools).toBeUndefined();
      expect(events.at(-1)?.type).toBe("done");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not retry on a 400 error unrelated to tool support", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => {
      return new Response("bad request: invalid model name", { status: 400 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const streamFn = createOllamaStreamFn("http://localhost:11434");
      const stream = await streamFn(
        {
          id: "gemma3:1b",
          api: "ollama",
          provider: "custom-ollama",
          contextWindow: 65536,
        } as unknown as Parameters<typeof streamFn>[0],
        makeContextWithTools() as unknown as Parameters<typeof streamFn>[1],
        {} as unknown as Parameters<typeof streamFn>[2],
      );

      const events = await collectStreamEvents(stream);

      // Only one fetch attempt — no retry
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(events.at(-1)?.type).toBe("error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("createOllamaStreamFn", () => {
  it("normalizes /v1 baseUrl and maps maxTokens + signal", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"ok"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
      ],
      async (fetchMock) => {
        const signal = new AbortController().signal;
        const stream = await createOllamaTestStream({
          baseUrl: "http://ollama-host:11434/v1/",
          options: { maxTokens: 123, signal },
        });

        const events = await collectStreamEvents(stream);
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
      },
    );
  });

  it("merges default headers and allows request headers to override them", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"ok"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
      ],
      async (fetchMock) => {
        const stream = await createOllamaTestStream({
          baseUrl: "http://ollama-host:11434",
          defaultHeaders: {
            "X-OLLAMA-KEY": "provider-secret",
            "X-Trace": "default",
          },
          options: {
            headers: {
              "X-Trace": "request",
              "X-Request-Only": "1",
            },
          },
        });

        const events = await collectStreamEvents(stream);
        expect(events.at(-1)?.type).toBe("done");

        const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(requestInit.headers).toMatchObject({
          "Content-Type": "application/json",
          "X-OLLAMA-KEY": "provider-secret",
          "X-Trace": "request",
          "X-Request-Only": "1",
        });
      },
    );
  });

  it("preserves an explicit Authorization header when apiKey is a local marker", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"ok"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
      ],
      async (fetchMock) => {
        const stream = await createOllamaTestStream({
          baseUrl: "http://ollama-host:11434",
          defaultHeaders: {
            Authorization: "Bearer proxy-token",
          },
          options: {
            apiKey: "ollama-local", // pragma: allowlist secret
            headers: {
              Authorization: "Bearer proxy-token",
            },
          },
        });

        await collectStreamEvents(stream);
        const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(requestInit.headers).toMatchObject({
          Authorization: "Bearer proxy-token",
        });
      },
    );
  });

  it("allows a real apiKey to override an explicit Authorization header", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"ok"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
      ],
      async (fetchMock) => {
        const streamFn = createOllamaStreamFn("http://ollama-host:11434", {
          Authorization: "Bearer proxy-token",
        });
        const stream = await Promise.resolve(
          streamFn(
            {
              id: "qwen3:32b",
              api: "ollama",
              provider: "custom-ollama",
              contextWindow: 131072,
            } as never,
            {
              messages: [{ role: "user", content: "hello" }],
            } as never,
            {
              apiKey: "real-token", // pragma: allowlist secret
            } as never,
          ),
        );

        await collectStreamEvents(stream);
        const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(requestInit.headers).toMatchObject({
          Authorization: "Bearer real-token",
        });
      },
    );
  });

  it("drops thinking chunks when no final content is emitted", async () => {
    await expectDoneEventContent(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","thinking":"reasoned"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","thinking":" output"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":2}',
      ],
      [],
    );
  });

  it("prefers streamed content over earlier thinking chunks", async () => {
    await expectDoneEventContent(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","thinking":"internal"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"final"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":" answer"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":2}',
      ],
      [{ type: "text", text: "final answer" }],
    );
  });

  it("drops reasoning chunks when no final content is emitted", async () => {
    await expectDoneEventContent(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","reasoning":"reasoned"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","reasoning":" output"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":2}',
      ],
      [],
    );
  });

  it("prefers streamed content over earlier reasoning chunks", async () => {
    await expectDoneEventContent(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","reasoning":"internal"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"final"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":" answer"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":2}',
      ],
      [{ type: "text", text: "final answer" }],
    );
  });
});

describe("resolveOllamaBaseUrlForRun", () => {
  it("prefers provider baseUrl over model baseUrl", () => {
    expect(
      resolveOllamaBaseUrlForRun({
        modelBaseUrl: "http://model-host:11434",
        providerBaseUrl: "http://provider-host:11434",
      }),
    ).toBe("http://provider-host:11434");
  });

  it("falls back to model baseUrl when provider baseUrl is missing", () => {
    expect(
      resolveOllamaBaseUrlForRun({
        modelBaseUrl: "http://model-host:11434",
      }),
    ).toBe("http://model-host:11434");
  });

  it("falls back to native default when neither baseUrl is configured", () => {
    expect(resolveOllamaBaseUrlForRun({})).toBe("http://127.0.0.1:11434");
  });
});

describe("createConfiguredOllamaStreamFn", () => {
  it("uses provider-level baseUrl when model baseUrl is absent", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"ok"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
      ],
      async (fetchMock) => {
        const streamFn = createConfiguredOllamaStreamFn({
          model: {
            headers: { Authorization: "Bearer proxy-token" },
          },
          providerBaseUrl: "http://provider-host:11434/v1",
        });
        const stream = await Promise.resolve(
          streamFn(
            {
              id: "qwen3:32b",
              api: "ollama",
              provider: "custom-ollama",
              contextWindow: 131072,
            } as never,
            {
              messages: [{ role: "user", content: "hello" }],
            } as never,
            {
              apiKey: "ollama-local", // pragma: allowlist secret
            } as never,
          ),
        );

        await collectStreamEvents(stream);
        const [url, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("http://provider-host:11434/api/chat");
        expect(requestInit.headers).toMatchObject({
          Authorization: "Bearer proxy-token",
        });
      },
    );
  });
});
