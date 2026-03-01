import { describe, expect, it, vi } from "vitest";
import {
  convertMessages,
  extractTextFromContent,
  convertTools,
  parseAwsEventStream,
  createBedrockInvokeStreamFn,
  type SseEvent,
} from "./bedrock-invoke-stream.js";

// ── convertMessages ──────────────────────────────────────────────────────────

describe("convertMessages", () => {
  it("converts user text messages", () => {
    const result = convertMessages([{ role: "user", content: "hello" }]);
    expect(result).toEqual([{ role: "user", content: "hello" }]);
  });

  it("converts user multipart messages (text + image)", () => {
    const result = convertMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image", data: "aW1hZ2VkYXRh", mimeType: "image/jpeg" },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: "aW1hZ2VkYXRh" },
          },
        ],
      },
    ]);
  });

  it("defaults image mimeType to image/png", () => {
    const result = convertMessages([{ role: "user", content: [{ type: "image", data: "abc" }] }]);
    const block = (result[0].content as Array<Record<string, unknown>>)[0] as {
      source: { media_type: string };
    };
    expect(block.source.media_type).toBe("image/png");
  });

  it("converts assistant text messages", () => {
    const result = convertMessages([{ role: "assistant", content: "ok" }]);
    expect(result).toEqual([{ role: "assistant", content: "ok" }]);
  });

  it("converts assistant toolCall content blocks to tool_use format", () => {
    const result = convertMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } },
        ],
      },
    ]);
  });

  it("converts assistant tool_use content blocks (pass-through)", () => {
    const result = convertMessages([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "read", input: { path: "/tmp" } }],
      },
    ]);
    expect(result).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "read", input: { path: "/tmp" } }],
      },
    ]);
  });

  it("converts tool/toolResult role messages to user + tool_result block", () => {
    const result = convertMessages([
      { role: "tool", content: "file list output", toolCallId: "call_1" } as {
        role: string;
        content: unknown;
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    const blocks = result[0].content as Array<{
      type: string;
      tool_use_id: string;
      content: string;
    }>;
    expect(blocks[0].type).toBe("tool_result");
    expect(blocks[0].tool_use_id).toBe("call_1");
    expect(blocks[0].content).toBe("file list output");
  });

  it("generates a random tool_use_id when toolCallId is missing", () => {
    const result = convertMessages([{ role: "tool", content: "output" }]);
    const blocks = result[0].content as Array<{ tool_use_id: string }>;
    expect(blocks[0].tool_use_id).toMatch(/^tool_/);
  });

  it("returns empty array for empty messages", () => {
    expect(convertMessages([])).toEqual([]);
  });

  it("falls back to empty content for non-string non-array user content", () => {
    const result = convertMessages([{ role: "user", content: 42 }]);
    expect(result).toEqual([{ role: "user", content: "" }]);
  });
});

// ── extractTextFromContent ───────────────────────────────────────────────────

describe("extractTextFromContent", () => {
  it("returns string content directly", () => {
    expect(extractTextFromContent("hello")).toBe("hello");
  });

  it("extracts text parts from an array", () => {
    const content = [
      { type: "text", text: "first" },
      { type: "image", data: "x" },
      { type: "text", text: "second" },
    ];
    expect(extractTextFromContent(content)).toBe("firstsecond");
  });

  it("returns empty string for non-array non-string", () => {
    expect(extractTextFromContent(42)).toBe("");
    expect(extractTextFromContent(null)).toBe("");
    expect(extractTextFromContent(undefined)).toBe("");
  });
});

// ── convertTools ─────────────────────────────────────────────────────────────

describe("convertTools", () => {
  it("converts name + description + parameters", () => {
    const tools = [
      {
        name: "bash",
        description: "Run commands",
        parameters: { type: "object", properties: { cmd: { type: "string" } } },
      },
    ];
    const result = convertTools(tools as never);
    expect(result).toEqual([
      {
        name: "bash",
        description: "Run commands",
        input_schema: { type: "object", properties: { cmd: { type: "string" } } },
      },
    ]);
  });

  it("skips tools with empty name", () => {
    const tools = [{ name: "", description: "no name" }];
    expect(convertTools(tools as never)).toEqual([]);
  });

  it("uses default parameters when not provided", () => {
    const tools = [{ name: "read", description: "Read files" }];
    const result = convertTools(tools as never);
    expect(result[0].input_schema).toEqual({ type: "object", properties: {} });
  });

  it("returns empty array for undefined input", () => {
    expect(convertTools(undefined)).toEqual([]);
  });

  it("returns empty array for null-ish input", () => {
    expect(convertTools(null as never)).toEqual([]);
  });
});

// ── parseAwsEventStream ──────────────────────────────────────────────────────

// Build a minimal AWS binary event stream frame for testing.
// Frame layout: [4B total_len][4B headers_len][4B prelude_crc][payload][4B message_crc]
function buildAwsFrame(payload: Uint8Array | string): Uint8Array {
  const payloadBytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const totalLength = 12 + payloadBytes.length + 4; // prelude(12) + payload + trailing CRC(4)
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, totalLength); // total_len
  view.setUint32(4, 0); // headers_len = 0
  view.setUint32(8, 0); // prelude_crc = 0
  frame.set(payloadBytes, 12);
  view.setUint32(totalLength - 4, 0); // message_crc = 0
  return frame;
}

function buildAwsEventFrame(event: SseEvent): Uint8Array {
  const innerJson = JSON.stringify(event);
  const base64 = Buffer.from(innerJson).toString("base64");
  const envelope = JSON.stringify({ bytes: base64 });
  return buildAwsFrame(envelope);
}

function mockAwsReader(frames: Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> {
  const combined = new Uint8Array(frames.reduce((sum, f) => sum + f.length, 0));
  let offset = 0;
  for (const f of frames) {
    combined.set(f, offset);
    offset += f.length;
  }
  let consumed = false;
  return {
    read: async () => {
      if (consumed) {
        return { done: true as const, value: undefined };
      }
      consumed = true;
      return { done: false as const, value: combined };
    },
    releaseLock: () => {},
    cancel: async () => {},
    closed: Promise.resolve(undefined),
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

async function collectEvents(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of parseAwsEventStream(reader)) {
    events.push(event);
  }
  return events;
}

describe("parseAwsEventStream", () => {
  it("parses message_start event", async () => {
    const event: SseEvent = {
      type: "message_start",
      message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } },
    };
    const reader = mockAwsReader([buildAwsEventFrame(event)]);
    const events = await collectEvents(reader);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("message_start");
  });

  it("parses content_block_start + content_block_delta (text)", async () => {
    const frames = [
      buildAwsEventFrame({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      buildAwsEventFrame({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello world" },
      }),
    ];
    const reader = mockAwsReader(frames);
    const events = await collectEvents(reader);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("content_block_start");
    expect(events[1].type).toBe("content_block_delta");
    if (events[1].type === "content_block_delta") {
      expect(events[1].delta).toEqual({ type: "text_delta", text: "Hello world" });
    }
  });

  it("parses tool_use content block", async () => {
    const frames = [
      buildAwsEventFrame({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "bash", input: "" },
      }),
      buildAwsEventFrame({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
      }),
    ];
    const reader = mockAwsReader(frames);
    const events = await collectEvents(reader);
    expect(events).toHaveLength(2);
    if (events[0].type === "content_block_start") {
      expect(events[0].content_block.type).toBe("tool_use");
    }
  });

  it("parses thinking content block", async () => {
    const frames = [
      buildAwsEventFrame({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }),
      buildAwsEventFrame({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me think..." },
      }),
    ];
    const reader = mockAwsReader(frames);
    const events = await collectEvents(reader);
    expect(events).toHaveLength(2);
    if (events[1].type === "content_block_delta") {
      expect(events[1].delta).toEqual({ type: "thinking_delta", thinking: "Let me think..." });
    }
  });

  it("skips frames with empty payload (no bytes field)", async () => {
    // Frame whose payload JSON has no `bytes` key
    const frame = buildAwsFrame(JSON.stringify({ noBytes: true }));
    const reader = mockAwsReader([frame]);
    const events = await collectEvents(reader);
    expect(events).toHaveLength(0);
  });

  it("handles incomplete frame across chunks", async () => {
    const fullFrame = buildAwsEventFrame({
      type: "message_start",
      message: { id: "msg_1" },
    });
    // Split the frame into two chunks
    const split = Math.floor(fullFrame.length / 2);
    const chunk1 = fullFrame.slice(0, split);
    const chunk2 = fullFrame.slice(split);

    let callCount = 0;
    const reader = {
      read: async () => {
        callCount++;
        if (callCount === 1) {
          return { done: false as const, value: chunk1 };
        }
        if (callCount === 2) {
          return { done: false as const, value: chunk2 };
        }
        return { done: true as const, value: undefined };
      },
      releaseLock: () => {},
      cancel: async () => {},
      closed: Promise.resolve(undefined),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;

    const events = await collectEvents(reader);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("message_start");
  });
});

// ── createBedrockInvokeStreamFn ──────────────────────────────────────────────

function buildFullAwsResponseBody(events: SseEvent[]): Uint8Array {
  const frames = events.map(buildAwsEventFrame);
  const total = frames.reduce((sum, f) => sum + f.length, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const f of frames) {
    body.set(f, offset);
    offset += f.length;
  }
  return body;
}

async function withMockAwsFetch(
  events: SseEvent[],
  run: (fetchMock: ReturnType<typeof vi.fn>) => Promise<void>,
  statusCode = 200,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const body = buildFullAwsResponseBody(events);
  const fetchMock = vi.fn(async () => {
    if (statusCode !== 200) {
      return new Response("Bad Request", { status: statusCode });
    }
    return new Response(Buffer.from(body), {
      status: 200,
      headers: { "Content-Type": "application/vnd.amazon.eventstream" },
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  try {
    await run(fetchMock);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function collectStreamEvents<T>(
  stream: AsyncIterable<T> | Promise<AsyncIterable<T>>,
): Promise<T[]> {
  const resolved = await stream;
  const events: T[] = [];
  for await (const event of resolved) {
    events.push(event);
  }
  return events;
}

const MODEL_INFO = {
  id: "claude-sonnet-4-6",
  api: "bedrock-invoke",
  provider: "corp-bedrock",
  contextWindow: 200000,
  maxTokens: 8192,
};

describe("createBedrockInvokeStreamFn", () => {
  it("sends correct URL and headers", async () => {
    const events: SseEvent[] = [
      { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 5 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];

    await withMockAwsFetch(events, async (fetchMock) => {
      const streamFn = createBedrockInvokeStreamFn("https://proxy.corp.net");
      const stream = streamFn(
        MODEL_INFO as never,
        { messages: [{ role: "user", content: "hello" }] } as never,
        { apiKey: "tok_123" } as never,
      );
      await collectStreamEvents(stream);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        "https://proxy.corp.net/model/claude-sonnet-4-6/invoke-with-response-stream",
      );
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer tok_123");
      expect(headers["api-key"]).toBe("tok_123");
    });
  });

  it("request body includes anthropic_version and excludes model/stream", async () => {
    const events: SseEvent[] = [
      { type: "message_start", message: { id: "msg_1" } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ];

    await withMockAwsFetch(events, async (fetchMock) => {
      const streamFn = createBedrockInvokeStreamFn("https://proxy.corp.net");
      const stream = streamFn(
        MODEL_INFO as never,
        { messages: [{ role: "user", content: "hello" }] } as never,
        { apiKey: "tok" } as never,
      );
      await collectStreamEvents(stream);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.anthropic_version).toBe("bedrock-2023-05-31");
      expect(body).not.toHaveProperty("model");
      expect(body).not.toHaveProperty("stream");
    });
  });

  it("happy path: text content yields done event", async () => {
    const events: SseEvent[] = [
      { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello world" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 3 },
      },
      { type: "message_stop" },
    ];

    await withMockAwsFetch(events, async () => {
      const streamFn = createBedrockInvokeStreamFn("https://proxy.corp.net");
      const stream = streamFn(
        MODEL_INFO as never,
        { messages: [{ role: "user", content: "hello" }] } as never,
        { apiKey: "tok" } as never,
      );
      const streamEvents = await collectStreamEvents(stream);
      const done = streamEvents.find((e) => (e as { type: string }).type === "done") as {
        type: "done";
        message: {
          content: Array<{ type: string; text?: string }>;
          stopReason: string;
          usage: { input: number; output: number };
        };
      };
      expect(done).toBeDefined();
      expect(done.message.content).toEqual([{ type: "text", text: "Hello world" }]);
      expect(done.message.stopReason).toBe("stop");
      expect(done.message.usage.input).toBe(10);
      expect(done.message.usage.output).toBe(3);
    });
  });

  it("tool_use flow yields stopReason toolUse", async () => {
    const events: SseEvent[] = [
      { type: "message_start", message: { id: "msg_1" } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "bash", input: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ];

    await withMockAwsFetch(events, async () => {
      const streamFn = createBedrockInvokeStreamFn("https://proxy.corp.net");
      const stream = streamFn(
        MODEL_INFO as never,
        { messages: [{ role: "user", content: "use bash" }] } as never,
        { apiKey: "tok" } as never,
      );
      const streamEvents = await collectStreamEvents(stream);
      const done = streamEvents.find((e) => (e as { type: string }).type === "done") as {
        type: "done";
        reason: string;
        message: { stopReason: string; content: Array<{ type: string; name?: string }> };
      };
      expect(done).toBeDefined();
      expect(done.reason).toBe("toolUse");
      expect(done.message.stopReason).toBe("toolUse");
      expect(done.message.content[0].type).toBe("toolCall");
      expect(done.message.content[0].name).toBe("bash");
    });
  });

  it("emits error event on non-200 response", async () => {
    await withMockAwsFetch(
      [],
      async () => {
        const streamFn = createBedrockInvokeStreamFn("https://proxy.corp.net");
        const stream = streamFn(
          MODEL_INFO as never,
          { messages: [{ role: "user", content: "hello" }] } as never,
          { apiKey: "tok" } as never,
        );
        const streamEvents = await collectStreamEvents(stream);
        const error = streamEvents.find((e) => (e as { type: string }).type === "error") as {
          type: "error";
          error: { errorMessage: string };
        };
        expect(error).toBeDefined();
        expect(error.error.errorMessage).toMatch(/400/);
      },
      400,
    );
  });

  it("includes temperature in request body", async () => {
    const events: SseEvent[] = [
      { type: "message_start", message: { id: "msg_1" } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ];

    await withMockAwsFetch(events, async (fetchMock) => {
      const streamFn = createBedrockInvokeStreamFn("https://proxy.corp.net");
      const stream = streamFn(
        MODEL_INFO as never,
        { messages: [{ role: "user", content: "hello" }] } as never,
        { apiKey: "tok", temperature: 0.7 } as never,
      );
      await collectStreamEvents(stream);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.temperature).toBe(0.7);
    });
  });

  it("trims trailing slash from baseUrl", async () => {
    const events: SseEvent[] = [
      { type: "message_start", message: { id: "msg_1" } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ];

    await withMockAwsFetch(events, async (fetchMock) => {
      const streamFn = createBedrockInvokeStreamFn("https://proxy.corp.net///");
      const stream = streamFn(
        MODEL_INFO as never,
        { messages: [{ role: "user", content: "hello" }] } as never,
        { apiKey: "tok" } as never,
      );
      await collectStreamEvents(stream);

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe(
        "https://proxy.corp.net/model/claude-sonnet-4-6/invoke-with-response-stream",
      );
    });
  });
});
