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
  it("returns a typed tool call with measured usage", async () => {
    native.run.mockResolvedValue({
      text: "",
      toolCalls: [call],
      inputTokens: 3995,
      outputTokens: 18,
    });
    const stream = await createAppleFmStream(native)(model, context);
    const events = [];
    for await (const event of stream) {
      events.push(event.type);
      if (event.type === "toolcall_delta") {
        expect(event.partial.content[event.contentIndex]).toMatchObject({
          partialJson: JSON.stringify(call.arguments),
        });
      }
    }
    const result = await stream.result();
    expect(result).toMatchObject({
      stopReason: "toolUse",
      content: [{ type: "toolCall", ...call }],
      usage: { input: 3995, output: 18, totalTokens: 4013 },
    });
    expect(events).toEqual(["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
    expect(result.content[0]).not.toHaveProperty("partialJson");
  });

  it.each([
    {
      name: "caller pattern despite replaced native constraints",
      schema: { type: "string", pattern: "^[a-f0-9]{8}$" },
      text: '{"value":"invalid"}',
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
        onPayload: () => ({ messages: context.messages, responseFormat: { type: "object" } }),
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
    const text = '  {"value":"9007199254740993","integer":1e3,"fraction":0.25,"notes":null}\n';
    const responseFormat = {
      type: "object",
      properties: {
        value: { type: "string", minLength: 1, maxLength: 16 },
        integer: { type: "integer", const: 1000 },
        fraction: { type: "number", const: 0.25 },
        notes: { anyOf: [{ type: "string" }, { type: "null" }] },
        fallback: { type: "string", default: "unused" },
      },
      required: ["value", "integer", "fraction", "notes"],
    };
    native.run.mockResolvedValue({ text, toolCalls: [], inputTokens: 10, outputTokens: 10 });
    const stream = await createAppleFmStream(native)(model, context, {
      responseFormat,
      maxTokens: 128,
    });
    expect(await stream.result()).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text }],
    });
    expect(native.run).toHaveBeenCalledWith(
      expect.objectContaining({ responseFormat, maxTokens: 128 }),
      expect.anything(),
    );
  });

  it.each(["9007199254740993", "9.007199254740993e15", "1e999"])(
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

  it("does not publish a tool call after cancellation during native inference", async () => {
    const abort = new AbortController();
    native.run.mockImplementation(async () => {
      abort.abort();
      return { text: "", toolCalls: [call], inputTokens: 10, outputTokens: 10 };
    });
    const stream = await createAppleFmStream(native)(model, context, { signal: abort.signal });
    expect(await stream.result()).toMatchObject({ stopReason: "aborted", content: [] });
  });
});
