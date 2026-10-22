import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppleFmNative, AppleFmResult } from "./native.js";
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
      parameters: Type.Object({ action: Type.Literal("connect_channel"), channel: Type.String() }),
    },
  ],
};
const call = {
  id: "call-1",
  name: "openclaw",
  arguments: { action: "connect_channel", channel: "telegram" },
};
const schema = (value: object) => ({ type: "object", properties: { value }, required: ["value"] });
const emptyResult: AppleFmResult = { text: "", toolCalls: [], inputTokens: 10, outputTokens: 10 };
function respond(result: Partial<AppleFmResult>) {
  native.run.mockResolvedValue({ ...emptyResult, ...result });
}
beforeEach(() => vi.clearAllMocks());

describe("Apple Foundation Models native transport", () => {
  it("returns a typed tool call with measured usage", async () => {
    respond({ toolCalls: [call], inputTokens: 3995, outputTokens: 18 });
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
    ["caller pattern", { type: "string", pattern: "^[a-f0-9]{8}$" }, '{"value":"invalid"}'],
    ["malformed JSON", { type: "string" }, "Bearer synthetic-private-note-9281"],
    ["unsafe integer", { type: "string" }, '{"value":9007199254740993}'],
    ["unsafe exponent", { type: "string" }, '{"value":9.007199254740993e15}'],
    ["overflow", { type: "string" }, '{"value":1e999}'],
  ] as const)(
    "rejects %s before publishing despite replaced native constraints",
    async (name, value, text) => {
      respond({ text });
      const stream = await createAppleFmStream(native)(model, context, {
        responseFormat: schema(value),
        onPayload: () => ({
          messages: context.messages,
          responseFormat: schema({ type: name === "caller pattern" ? "string" : "number" }),
        }),
      });
      const events = [];
      for await (const event of stream) {
        events.push(event.type);
      }
      const result = await stream.result();
      expect(result).toMatchObject({ stopReason: "error", content: [] });
      expect(result.errorMessage).toContain("invalid structured response");
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
    respond({ text });
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

  it("does not publish a tool call after cancellation during native inference", async () => {
    const abort = new AbortController();
    native.run.mockImplementation(async () => {
      abort.abort();
      return { ...emptyResult, toolCalls: [call] };
    });
    const stream = await createAppleFmStream(native)(model, context, { signal: abort.signal });
    expect(await stream.result()).toMatchObject({ stopReason: "aborted", content: [] });
  });
});
