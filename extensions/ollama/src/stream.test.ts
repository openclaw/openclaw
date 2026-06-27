// Ollama tests cover stream plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import {
  buildAssistantMessage,
  createOllamaStreamFn,
  normalizeOllamaCompatMessageToolArgs,
} from "./stream.js";

function makeOllamaResponse(params: {
  content?: string;
  thinking?: string;
  reasoning?: string;
  done_reason?: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}) {
  return {
    model: "qwen3.5",
    created_at: new Date().toISOString(),
    message: {
      role: "assistant" as const,
      content: params.content ?? "",
      ...(params.thinking != null ? { thinking: params.thinking } : {}),
      ...(params.reasoning != null ? { reasoning: params.reasoning } : {}),
      ...(params.tool_calls ? { tool_calls: params.tool_calls } : {}),
    },
    done: true,
    ...(params.done_reason ? { done_reason: params.done_reason } : {}),
    prompt_eval_count: 100,
    eval_count: 50,
  };
}

const MODEL_INFO = { api: "ollama", provider: "ollama", id: "qwen3.5" };

describe("buildAssistantMessage", () => {
  it("includes thinking block when response has thinking field", () => {
    const response = makeOllamaResponse({
      thinking: "Let me think about this",
      content: "The answer is 42",
    });
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.content).toHaveLength(2);
    expect(msg.content[0]).toEqual({ type: "thinking", thinking: "Let me think about this" });
    expect(msg.content[1]).toEqual({ type: "text", text: "The answer is 42" });
  });

  it("includes thinking block when response has reasoning field", () => {
    const response = makeOllamaResponse({
      reasoning: "Step by step analysis",
      content: "Result is 7",
    });
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.content).toHaveLength(2);
    expect(msg.content[0]).toEqual({ type: "thinking", thinking: "Step by step analysis" });
    expect(msg.content[1]).toEqual({ type: "text", text: "Result is 7" });
  });

  it("prefers thinking over reasoning when both are present", () => {
    const response = makeOllamaResponse({
      thinking: "From thinking field",
      reasoning: "From reasoning field",
      content: "Answer",
    });
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.content[0]).toEqual({ type: "thinking", thinking: "From thinking field" });
  });

  it("omits thinking block when no thinking or reasoning field", () => {
    const response = makeOllamaResponse({
      content: "Just text",
    });
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]).toEqual({ type: "text", text: "Just text" });
  });

  it("omits thinking block when thinking field is empty", () => {
    const response = makeOllamaResponse({
      thinking: "",
      content: "Just text",
    });
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]).toEqual({ type: "text", text: "Just text" });
  });

  it("preserves output-budget length stops", () => {
    const response = makeOllamaResponse({
      content: "Partial answer",
      done_reason: "length",
    });
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.stopReason).toBe("length");
  });

  it("keeps a length stop authoritative over complete-looking tool calls", () => {
    const response = makeOllamaResponse({
      done_reason: "length",
      tool_calls: [{ function: { name: "read", arguments: { path: "README.md" } } }],
    });
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.stopReason).toBe("length");
  });
});

describe("createOllamaStreamFn thinking events", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.useRealTimers();
  });

  function makeNdjsonBody(chunks: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const lines = chunks.map((c) => JSON.stringify(c) + "\n").join("");
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(lines));
        controller.close();
      },
    });
  }

  async function streamOllamaEvents(
    chunks: Array<Record<string, unknown>>,
    options: Parameters<ReturnType<typeof createOllamaStreamFn>>[2] = {},
    context: Parameters<ReturnType<typeof createOllamaStreamFn>>[1] = {
      messages: [{ role: "user", content: "test" }],
    } as never,
  ): Promise<Array<{ type: string; [key: string]: unknown }>> {
    const body = makeNdjsonBody(chunks);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(body, { status: 200 }),
      release: vi.fn(async () => undefined),
    });

    const streamFn = createOllamaStreamFn("http://localhost:11434");
    const stream = streamFn(
      { api: "ollama", provider: "ollama", id: "qwen3.5", contextWindow: 65536 } as never,
      context,
      options,
    );

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of stream as AsyncIterable<{
      type: string;
      [key: string]: unknown;
    }>) {
      events.push(event);
    }
    return events;
  }

  it("emits thinking_start, thinking_delta, and thinking_end events for thinking content", async () => {
    const thinkingChunks = [
      {
        model: "qwen3.5",
        created_at: "2026-01-01T00:00:00Z",
        message: { role: "assistant", content: "", thinking: "Step 1" },
        done: false,
      },
      {
        model: "qwen3.5",
        created_at: "2026-01-01T00:00:01Z",
        message: { role: "assistant", content: "", thinking: " and step 2" },
        done: false,
      },
      {
        model: "qwen3.5",
        created_at: "2026-01-01T00:00:02Z",
        message: { role: "assistant", content: "The answer", thinking: "" },
        done: false,
      },
      {
        model: "qwen3.5",
        created_at: "2026-01-01T00:00:03Z",
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 10,
        eval_count: 5,
      },
    ];

    const events = await streamOllamaEvents(thinkingChunks);
    const eventTypes = events.map((e) => e.type);

    expect(eventTypes).toContain("thinking_start");
    expect(eventTypes).toContain("thinking_delta");
    expect(eventTypes).toContain("thinking_end");
    expect(eventTypes).toContain("text_start");
    expect(eventTypes).toContain("text_delta");
    expect(eventTypes).toContain("done");

    const thinkingStartIndex = eventTypes.indexOf("thinking_start");
    const textStartIndex = eventTypes.indexOf("text_start");
    expect(thinkingStartIndex).toBeLessThan(textStartIndex);

    const thinkingEndIndex = eventTypes.indexOf("thinking_end");
    expect(thinkingEndIndex).toBeLessThan(textStartIndex);

    const thinkingDeltas = events.filter((e) => e.type === "thinking_delta");
    expect(thinkingDeltas).toHaveLength(2);
    expect(thinkingDeltas[0].delta).toBe("Step 1");
    expect(thinkingDeltas[1].delta).toBe(" and step 2");

    const thinkingStart = events.find((e) => e.type === "thinking_start");
    expect(thinkingStart?.contentIndex).toBe(0);
    const textStart = events.find((e) => e.type === "text_start");
    expect(textStart?.contentIndex).toBe(1);

    const done = events.find((e) => e.type === "done") as { message?: { content: unknown[] } };
    const content = done?.message?.content ?? [];
    expect(content[0]).toEqual({ type: "thinking", thinking: "Step 1 and step 2" });
    expect(content[1]).toEqual({ type: "text", text: "The answer" });
  });

  it("streams without thinking events when no thinking content is present", async () => {
    const chunks = [
      {
        model: "qwen3.5",
        created_at: "2026-01-01T00:00:00Z",
        message: { role: "assistant", content: "Hello" },
        done: false,
      },
      {
        model: "qwen3.5",
        created_at: "2026-01-01T00:00:01Z",
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 10,
        eval_count: 5,
      },
    ];

    const events = await streamOllamaEvents(chunks);
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).not.toContain("thinking_start");
    expect(eventTypes).not.toContain("thinking_delta");
    expect(eventTypes).not.toContain("thinking_end");
    expect(eventTypes).toContain("text_start");
    expect(eventTypes).toContain("text_delta");
    expect(eventTypes).toContain("done");

    const textStart = events.find((e) => e.type === "text_start") as { contentIndex?: number };
    expect(textStart?.contentIndex).toBe(0);
  });

  it("emits length for a token-limited native stream", async () => {
    const events = await streamOllamaEvents([
      {
        model: "qwen3.5",
        created_at: "2026-01-01T00:00:00Z",
        message: { role: "assistant", content: "Partial answer" },
        done: false,
      },
      {
        model: "qwen3.5",
        created_at: "2026-01-01T00:00:01Z",
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "length",
        prompt_eval_count: 10,
        eval_count: 5,
      },
    ]);

    const done = events.find((event) => event.type === "done") as {
      reason?: string;
      message?: { stopReason?: string };
    };
    expect(done.reason).toBe("length");
    expect(done.message?.stopReason).toBe("length");
  });

  it("preserves a native length stop when the partial response contains tool calls", async () => {
    const events = await streamOllamaEvents(
      [
        makeOllamaResponse({
          done_reason: "length",
          tool_calls: [{ function: { name: "read", arguments: { path: "README.md" } } }],
        }),
      ],
      {},
      {
        messages: [{ role: "user", content: "test" }],
        tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
      } as never,
    );

    const done = events.find((event) => event.type === "done") as {
      reason?: string;
      message?: { content?: Array<Record<string, unknown>>; stopReason?: string };
    };
    expect(done.reason).toBe("length");
    expect(done.message?.stopReason).toBe("length");
    expect(done.message?.content).toEqual([
      expect.objectContaining({ type: "toolCall", name: "read" }),
    ]);
  });

  it("uses generic stream timeout for Ollama request timeout", async () => {
    await streamOllamaEvents([makeOllamaResponse({ content: "ok" })], { timeoutMs: 2500 });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "http://localhost:11434/api/chat",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.5",
          messages: [{ role: "user", content: "test" }],
          stream: true,
          options: {},
        }),
      },
      policy: {
        allowPrivateNetwork: true,
        hostnameAllowlist: ["localhost"],
      },
      timeoutMs: 2500,
      auditContext: "ollama-stream.chat",
    });
  });

  it("promotes standalone bracketed local-model tool text to a structured tool call", async () => {
    const rawToolText = [
      "[mempalace_mempalace_search]",
      '{"query":"codename","wing":"personal","room":"identities"}',
      "[END_TOOL_REQUEST]",
    ].join("\n");

    const events = await streamOllamaEvents(
      [
        {
          model: "qwen3.5",
          created_at: "2026-01-01T00:00:00Z",
          message: { role: "assistant", content: rawToolText },
          done: false,
        },
        {
          model: "qwen3.5",
          created_at: "2026-01-01T00:00:01Z",
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 10,
          eval_count: 5,
        },
      ],
      {},
      {
        messages: [{ role: "user", content: "test" }],
        tools: [
          {
            name: "mempalace_mempalace_search",
            description: "Search MemPalace",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as never,
    );

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "done",
    ]);
    const done = events.find((event) => event.type === "done") as {
      message?: { content?: Array<Record<string, unknown>>; stopReason?: string };
      reason?: string;
    };
    expect(done.reason).toBe("toolUse");
    expect(done.message?.stopReason).toBe("toolUse");
    expect(done.message?.content?.[0]).toMatchObject({
      type: "toolCall",
      name: "mempalace_mempalace_search",
      arguments: { query: "codename", wing: "personal", room: "identities" },
    });
  });

  it("promotes standalone Harmony local-model tool text to a structured tool call", async () => {
    const rawToolText =
      'commentary to=read code {"path":"/path/to/file","line_start":1,"line_end":400}';

    const events = await streamOllamaEvents(
      [
        {
          model: "qwen3.5",
          created_at: "2026-01-01T00:00:00Z",
          message: { role: "assistant", content: rawToolText },
          done: false,
        },
        {
          model: "qwen3.5",
          created_at: "2026-01-01T00:00:01Z",
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 10,
          eval_count: 5,
        },
      ],
      {},
      {
        messages: [{ role: "user", content: "test" }],
        tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
      } as never,
    );

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "done",
    ]);
    const done = events.find((event) => event.type === "done") as {
      message?: { content?: Array<Record<string, unknown>>; stopReason?: string };
      reason?: string;
    };
    expect(done.reason).toBe("toolUse");
    expect(done.message?.content?.[0]).toMatchObject({
      type: "toolCall",
      name: "read",
      arguments: { path: "/path/to/file", line_start: 1, line_end: 400 },
    });
  });

  it("yields to the event loop while processing dense native stream chunks", async () => {
    const chunks = [
      ...Array.from({ length: 65 }, (_value, index) => ({
        model: "qwen3.5",
        created_at: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}Z`,
        message: { role: "assistant" as const, content: "x" },
        done: false,
      })),
      makeOllamaResponse({ content: "" }),
    ];
    const body = makeNdjsonBody(chunks);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(body, { status: 200 }),
      release: vi.fn(async () => undefined),
    });

    const streamFn = createOllamaStreamFn("http://localhost:11434");
    const stream = streamFn(
      { api: "ollama", provider: "ollama", id: "qwen3.5", contextWindow: 65536 } as never,
      { messages: [{ role: "user", content: "test" }] } as never,
      {},
    );

    let timerFired = false;
    const timerPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerFired = true;
        resolve();
      }, 0);
    });
    let yieldedBeforeDone = false;
    for await (const event of stream as AsyncIterable<{ type: string }>) {
      if (timerFired && event.type !== "done") {
        yieldedBeforeDone = true;
      }
    }
    await timerPromise;

    expect(yieldedBeforeDone).toBe(true);
  });

  it("reports caller aborts during dense native stream processing as aborted", async () => {
    const chunks = [
      ...Array.from({ length: 65 }, (_value, index) => ({
        model: "qwen3.5",
        created_at: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}Z`,
        message: { role: "assistant" as const, content: "x" },
        done: false,
      })),
      makeOllamaResponse({ content: "" }),
    ];
    const body = makeNdjsonBody(chunks);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(body, { status: 200 }),
      release: vi.fn(async () => undefined),
    });

    const controller = new AbortController();
    const streamFn = createOllamaStreamFn("http://localhost:11434");
    const stream = streamFn(
      { api: "ollama", provider: "ollama", id: "qwen3.5", contextWindow: 65536 } as never,
      { messages: [{ role: "user", content: "test" }] } as never,
      { signal: controller.signal },
    );

    setTimeout(() => {
      controller.abort();
    }, 0);

    const events: Array<{ type: string; reason?: string; error?: { stopReason?: string } }> = [];
    for await (const event of stream as AsyncIterable<{
      type: string;
      reason?: string;
      error?: { stopReason?: string };
    }>) {
      events.push(event);
    }

    const lastEvent = events.at(-1);
    expect(lastEvent).toMatchObject({
      type: "error",
      reason: "aborted",
      error: { stopReason: "aborted" },
    });
  });
});

describe("normalizeOllamaCompatMessageToolArgs (OpenAI-compatible Ollama Cloud)", () => {
  // Regression for #96441: Ollama Cloud (*:cloud) proxies through an
  // OpenAI-compatible Go server that requires tool_calls[].function.arguments
  // to be a JSON STRING. Replaying assistant tool-call history on the 2nd turn
  // with object-form arguments produced:
  //   400 json: cannot unmarshal object into Go struct field
  //   .messages.tool_calls.function.arguments of type string
  it("serializes object tool-call arguments to a JSON string", () => {
    const payload = {
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "config.get", arguments: { key: "gateway.port" } },
            },
          ],
        },
      ],
    };

    normalizeOllamaCompatMessageToolArgs(payload);

    const args = (payload.messages[0].tool_calls as Array<Record<string, never>>)[0].function
      .arguments;
    expect(typeof args).toBe("string");
    expect(JSON.parse(args as unknown as string)).toEqual({ key: "gateway.port" });
  });

  it("leaves already-stringified arguments unchanged (no double-encoding)", () => {
    const payload = {
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              function: { name: "search", arguments: '{"q":"hello"}' },
            },
          ],
        },
      ],
    };

    normalizeOllamaCompatMessageToolArgs(payload);

    const args = (payload.messages[0].tool_calls as Array<Record<string, never>>)[0].function
      .arguments;
    expect(args).toBe('{"q":"hello"}');
    expect(JSON.parse(args as unknown as string)).toEqual({ q: "hello" });
  });

  it("normalizes the legacy function_call shape to a string", () => {
    const payload = {
      messages: [
        {
          role: "assistant",
          content: "",
          function_call: { name: "lookup", arguments: { id: 42 } },
        },
      ],
    };

    normalizeOllamaCompatMessageToolArgs(payload);

    const args = (payload.messages[0].function_call as Record<string, unknown>).arguments;
    expect(typeof args).toBe("string");
    expect(JSON.parse(args as string)).toEqual({ id: 42 });
  });

  it("handles the second-turn replay payload from the bug report", () => {
    // assistant tool call followed by its tool result, replayed on turn 2
    const payload = {
      messages: [
        { role: "user", content: "What is config.gateway.port?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_abc",
              type: "function",
              function: { name: "config.get", arguments: { key: "gateway.port" } },
            },
          ],
        },
        { role: "tool", tool_name: "config.get", content: "8642" },
      ],
    };

    normalizeOllamaCompatMessageToolArgs(payload);

    const assistant = payload.messages[1] as {
      tool_calls: Array<{ function: { arguments: unknown } }>;
    };
    expect(typeof assistant.tool_calls[0].function.arguments).toBe("string");
    // user + tool messages untouched
    expect(payload.messages[0]).toEqual({ role: "user", content: "What is config.gateway.port?" });
    expect(payload.messages[2]).toEqual({ role: "tool", tool_name: "config.get", content: "8642" });
  });

  it("is a no-op when there are no messages or tool calls", () => {
    const empty = { model: "glm-5.2:cloud" } as Record<string, unknown>;
    expect(() => normalizeOllamaCompatMessageToolArgs(empty)).not.toThrow();

    const plain = { messages: [{ role: "user", content: "hi" }] };
    normalizeOllamaCompatMessageToolArgs(plain);
    expect(plain.messages[0]).toEqual({ role: "user", content: "hi" });
  });
});
