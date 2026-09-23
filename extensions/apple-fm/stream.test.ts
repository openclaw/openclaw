import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppleFmNative } from "./native.js";
import { createAppleFmStream } from "./stream.js";

const native = { run: vi.fn<AppleFmNative["run"]>() };
const model: Model<"openai-completions"> = {
  id: "system",
  name: "AFM 3 Core Advanced",
  provider: "apple-fm",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1",
  contextWindow: 8192,
  maxTokens: 1024,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context: Context = {
  systemPrompt: "Only propose actions through the supplied tool.",
  messages: [{ role: "user", content: "Connect Telegram.", timestamp: 0 }],
  tools: [
    {
      name: "openclaw",
      description: "Set up OpenClaw",
      parameters: Type.Object({
        action: Type.Literal("connect_channel"),
        channel: Type.String(),
        sha256: Type.Optional(Type.String({ pattern: "^[a-fA-F0-9]{64}$" })),
      }),
    },
  ],
};
const call = {
  id: "call-1",
  name: "openclaw",
  arguments: { action: "connect_channel", channel: "telegram" },
};

beforeEach(() => vi.clearAllMocks());

describe("Apple Foundation Models native transport", () => {
  it("returns a typed tool call with measured usage and preserves host validation schemas", async () => {
    native.run.mockResolvedValue({
      text: "",
      toolCalls: [call],
      inputTokens: 3995,
      outputTokens: 18,
    });
    const stream = await createAppleFmStream(native)(model, context, { maxTokens: 128 });
    const events = [];
    for await (const event of stream) {
      events.push(event.type);
    }
    const result = await stream.result();
    expect(result).toMatchObject({
      stopReason: "toolUse",
      content: [{ type: "toolCall", ...call }],
      usage: { input: 3995, output: 18, totalTokens: 4013 },
    });
    expect(events).toEqual(["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
    expect(native.run).toHaveBeenCalledWith(
      expect.objectContaining({ ...context, maxTokens: 128 }),
      expect.anything(),
    );
    expect(context.tools?.[0]?.parameters).toMatchObject({
      properties: { sha256: { pattern: "^[a-fA-F0-9]{64}$" } },
    });
  });

  it("replays the exact tool call identity and tool result for continuation", async () => {
    const continued: Context = {
      ...context,
      messages: [
        ...context.messages,
        {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: 1,
          content: [{ type: "toolCall", ...call }],
          stopReason: "toolUse",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
        {
          role: "toolResult",
          toolName: call.name,
          toolCallId: call.id,
          content: [{ type: "text", text: "The protected setup form is ready." }],
          isError: false,
          timestamp: 2,
        },
      ],
    };
    native.run.mockResolvedValue({
      text: "Continue in the setup form.",
      toolCalls: [],
      inputTokens: 4064,
      outputTokens: 8,
    });
    const stream = await createAppleFmStream(native)(model, continued);
    expect(await stream.result()).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "Continue in the setup form." }],
    });
    expect(native.run).toHaveBeenCalledWith(
      expect.objectContaining({ messages: continued.messages }),
      expect.anything(),
    );
  });

  it.each([
    { name: "minimum length", schema: { type: "string", minLength: 1 }, text: '{"value":""}' },
    { name: "maximum length", schema: { type: "string", maxLength: 3 }, text: '{"value":"long"}' },
    {
      name: "pattern",
      schema: { type: "string", pattern: "^[a-f0-9]{8}$" },
      text: '{"value":"invalid"}',
    },
    {
      name: "nullable union",
      schema: { anyOf: [{ type: "string" }, { type: "null" }] },
      text: '{"value":42}',
    },
    {
      name: "unsafe numeric bound",
      schema: { type: "number", maximum: 9007199254740992 },
      text: '{"value":9007199254740993}',
    },
    {
      name: "unsafe exponent numeric bound",
      schema: { type: "number", maximum: 9007199254740992 },
      text: '{"value":9.007199254740993e15}',
    },
    {
      name: "malformed JSON without echoing its text",
      schema: { type: "string" },
      text: "Bearer synthetic-private-note-9281",
    },
  ])(
    "rejects a structured response violating $name before publishing it",
    async ({ schema, text }) => {
      native.run.mockResolvedValue({ text, toolCalls: [], inputTokens: 10, outputTokens: 10 });
      const stream = await createAppleFmStream(native)(model, context, {
        responseFormat: { type: "object", properties: { value: schema }, required: ["value"] },
      });
      const events = [];
      for await (const event of stream) {
        events.push(event.type);
      }
      const result = await stream.result();
      expect(result).toMatchObject({
        stopReason: "error",
        content: [],
        errorMessage: expect.stringContaining("invalid structured response"),
      });
      expect(result.errorMessage).not.toContain("Bearer");
      expect(result.errorMessage).not.toContain("synthetic-private-note");
      expect(events).toEqual(["start", "error"]);
    },
  );

  it("preserves valid structured response bytes without injecting annotation defaults", async () => {
    const text = '  {"value":"ready","notes":null}\n';
    const responseFormat = {
      type: "object",
      properties: {
        value: { type: "string", minLength: 1, maxLength: 5 },
        notes: { anyOf: [{ type: "string" }, { type: "null" }] },
        fallback: { type: "string", default: "unused" },
      },
      required: ["value", "notes"],
    };
    native.run.mockResolvedValue({ text, toolCalls: [], inputTokens: 10, outputTokens: 10 });
    const stream = await createAppleFmStream(native)(model, context, { responseFormat });
    expect(await stream.result()).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text }],
    });
    expect(native.run).toHaveBeenCalledWith(
      expect.objectContaining({ responseFormat }),
      expect.anything(),
    );
  });

  it("validates the caller's schema even when a payload hook replaces native constraints", async () => {
    const responseFormat = {
      type: "object",
      properties: { value: { type: "string", minLength: 5 } },
      required: ["value"],
    };
    native.run.mockResolvedValue({
      text: '{"value":""}',
      toolCalls: [],
      inputTokens: 10,
      outputTokens: 10,
    });
    const stream = await createAppleFmStream(native)(model, context, {
      responseFormat,
      onPayload: () => ({ messages: context.messages, responseFormat: { type: "object" } }),
    });
    expect(await stream.result()).toMatchObject({ stopReason: "error", content: [] });
    expect(responseFormat.properties.value.minLength).toBe(5);
  });

  it.each(["9007199254740993", "-9007199254740993", "9.007199254740993e15", "1e999"])(
    "does not validate numeric output %s as a string after a payload hook changes the native schema",
    async (literal) => {
      native.run.mockResolvedValue({
        text: `{"value":${literal}}`,
        toolCalls: [],
        inputTokens: 10,
        outputTokens: 10,
      });
      const stream = await createAppleFmStream(native)(model, context, {
        responseFormat: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        onPayload: () => ({
          messages: context.messages,
          responseFormat: {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
          },
        }),
      });
      const events = [];
      for await (const event of stream) {
        events.push(event.type);
      }
      expect(await stream.result()).toMatchObject({
        stopReason: "error",
        content: [],
        errorMessage: expect.stringContaining("invalid structured response"),
      });
      expect(events).toEqual(["start", "error"]);
    },
  );

  it.each([
    { text: '{"value":"9007199254740993"}', schema: { type: "string" } },
    { text: '{"value":"9.007199254740993e15"}', schema: { type: "string" } },
    { text: '{"value":1e3}', schema: { type: "integer", const: 1000 } },
    { text: '{"value":0.25}', schema: { type: "number", const: 0.25 } },
  ])(
    "preserves valid numeric representations and digit strings: $text",
    async ({ text, schema }) => {
      native.run.mockResolvedValue({ text, toolCalls: [], inputTokens: 10, outputTokens: 10 });
      const stream = await createAppleFmStream(native)(model, context, {
        responseFormat: { type: "object", properties: { value: schema }, required: ["value"] },
      });
      expect(await stream.result()).toMatchObject({
        stopReason: "stop",
        content: [{ type: "text", text }],
      });
    },
  );

  it("does not publish a tool call after cancellation during native inference", async () => {
    const abort = new AbortController();
    native.run.mockImplementation(async () => {
      abort.abort();
      return { text: "", toolCalls: [call], inputTokens: 10, outputTokens: 10 };
    });
    const stream = await createAppleFmStream(native)(model, context, { signal: abort.signal });
    expect(await stream.result()).toMatchObject({ stopReason: "aborted", content: [] });
  });

  it("reports native failures through the stream without falling through to HTTP", async () => {
    native.run.mockRejectedValue(new Error("Apple Intelligence is disabled."));
    const stream = await createAppleFmStream(native)(model, context);
    expect(await stream.result()).toMatchObject({
      stopReason: "error",
      content: [],
      errorMessage: expect.stringContaining("Apple Intelligence is disabled"),
    });
  });
});
