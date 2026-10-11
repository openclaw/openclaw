import {
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  streamSimple,
  type Model,
  type ToolCall,
} from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

const GEMINI_MODEL = "gemini-3-6-flash";

function veniceModel(id: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    provider: "venice",
    api: "openai-completions",
    baseUrl: "https://api.venice.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 4096,
  };
}

function toolCall(
  id: string,
  name: string,
  thoughtSignature?: string,
  args: Record<string, unknown> = {},
): ToolCall {
  return { type: "toolCall", id, name, arguments: args, thoughtSignature };
}

function assistant(
  content: ToolCall[],
  route: Partial<Pick<AssistantMessage, "api" | "provider" | "model">> = {},
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "venice",
    model: GEMINI_MODEL,
    content,
    usage: createZeroUsageFixture(),
    stopReason: "toolUse",
    timestamp: 0,
    ...route,
  };
}

function wireCall(id: string, name: string, args?: string) {
  return {
    id,
    type: "function",
    function: { name, ...(args === undefined ? {} : { arguments: args }) },
  };
}

function wireAssistant(...calls: ReturnType<typeof wireCall>[]) {
  return { role: "assistant", tool_calls: calls };
}

function wireResult(id: string, content: string) {
  return { role: "tool", tool_call_id: id, content };
}

async function patchPayload(
  payload: { model: string; messages: Record<string, unknown>[] } & Record<string, unknown>,
  messages: Context["messages"] = [],
) {
  const provider = await registerSingleProviderPlugin(plugin);
  const streamFn = provider.wrapStreamFn?.({
    provider: "venice",
    modelId: payload.model,
    thinkingLevel: "high",
    streamFn: (model, _context, options) => {
      options?.onPayload?.(payload, model);
      const stream = createAssistantMessageEventStream();
      stream.end();
      return stream;
    },
  });
  expect(streamFn).toBeTypeOf("function");
  await streamFn?.(veniceModel(payload.model), { messages }, {});
  return payload;
}

describe("venice provider plugin", () => {
  it.each([
    { baseUrl: "https://api.venice.ai/api/v1", expected: "synthetic-session" },
    { baseUrl: "https://api.venice.ai/api/v1/", expected: "synthetic-session" },
    { baseUrl: "https://proxy.example/v1", expected: undefined },
    { baseUrl: "https://api.venice.ai/custom/v1", expected: undefined },
    { baseUrl: "https://api.venice.ai/api/v1", optOut: true, expected: undefined },
    { baseUrl: "https://api.venice.ai/api/v1", disabled: true, expected: undefined },
  ])(
    "sends cache affinity only for native enabled requests: $baseUrl, $optOut, $disabled",
    async (route) => {
      const provider = await registerSingleProviderPlugin(plugin);
      const model: Model = {
        ...veniceModel("synthetic-model"),
        baseUrl: route.baseUrl,
        ...(route.optOut ? { compat: { supportsPromptCacheKey: false } } : {}),
      };
      const normalized =
        provider.normalizeResolvedModel?.({ provider: model.provider, modelId: model.id, model }) ??
        model;
      let payload: unknown;
      const result = await streamSimple(
        normalized,
        { messages: [] },
        {
          apiKey: "synthetic-unused-key",
          sessionId: "synthetic-session",
          cacheRetention: route.disabled ? "none" : "long",
          onPayload(value) {
            payload = value;
            throw new Error("captured before request");
          },
        },
      ).result();
      expect(result.errorMessage).toBe("captured before request");
      expect(payload).toMatchObject({ prompt_cache_key: route.expected });
      expect(payload).not.toHaveProperty("prompt_cache_retention");
      expect(payload).not.toHaveProperty("prompt_cache_options");
    },
  );

  it("applies the shared xAI compat patch to Grok-backed Venice models only", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const model = { ...veniceModel("grok-4"), compat: { supportsUsageInStreaming: true } };
    expect(
      provider.normalizeResolvedModel?.({ provider: "venice", modelId: "venice/grok-4", model }),
    ).toMatchObject({
      ...model,
      compat: {
        supportsUsageInStreaming: true,
        toolSchemaProfile: "xai",
        unsupportedToolSchemaKeywords: [
          "minLength",
          "maxLength",
          "minItems",
          "maxItems",
          "minContains",
          "maxContains",
        ],
        toolCallArgumentsEncoding: "html-entities",
      },
    });
  });

  it("fills missing DeepSeek V4 reasoning_content on Venice replay turns", async () => {
    const payload = await patchPayload({
      model: "deepseek-v4-pro",
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      messages: [
        wireAssistant(wireCall("call_1", "read", "{}")),
        { role: "assistant", content: "done" },
      ],
    });
    expect(payload).toEqual({
      model: "deepseek-v4-pro",
      messages: [
        { ...wireAssistant(wireCall("call_1", "read", "{}")), reasoning_content: "" },
        { role: "assistant", content: "done", reasoning_content: "" },
      ],
    });
  });

  it("replays Gemini signatures and downgrades foreign tool history to text", async () => {
    const payload = {
      model: GEMINI_MODEL,
      messages: [
        { role: "user", content: "echo" },
        wireAssistant(wireCall("call_1", "echo_value", '{"value":"repro"}')),
        wireResult("call_1", "ok"),
      ],
    };
    const signed = await patchPayload(structuredClone(payload), [
      { role: "user", content: "echo", timestamp: 0 },
      assistant([toolCall("call_1", "echo_value", "SIG-VENICE-OPAQUE-ABC==", { value: "repro" })]),
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "echo_value",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 0,
      },
    ]);
    expect(signed.messages).toMatchObject([
      { role: "user", content: "echo" },
      {
        role: "assistant",
        tool_calls: [{ id: "call_1", thought_signature: "SIG-VENICE-OPAQUE-ABC==" }],
      },
      wireResult("call_1", "ok"),
    ]);
    expect(signed.messages[1]).not.toHaveProperty("tool_calls.0.extra_content");

    const foreign = await patchPayload(structuredClone(payload), [
      assistant([toolCall("call_1", "echo_value", "SIG-CROSS-ROUTE")], {
        api: "google-generative-ai",
        provider: "google",
      }),
    ]);
    expect(foreign.messages[1]).toMatchObject({
      role: "assistant",
      content: expect.stringContaining("[Historical tool call: echo_value("),
    });
    expect(foreign.messages[1]).not.toHaveProperty("tool_calls");
    expect(foreign.messages[2]).toEqual({
      role: "user",
      content: "[Historical tool result for echo_value:\nok]",
    });
  });

  it("downgrades mixed signed and unsigned Gemini tool batches to text history", async () => {
    const { messages } = await patchPayload(
      {
        model: GEMINI_MODEL,
        messages: [
          wireAssistant(
            wireCall("foreign_call", "web_fetch"),
            wireCall("legacy_call", "read"),
            wireCall("signed_call", "read"),
          ),
          wireResult("foreign_call", "foreign result"),
          wireResult("legacy_call", "legacy result"),
          wireResult("signed_call", "signed result"),
          { role: "user", content: "current prompt" },
        ],
      },
      [
        assistant([
          toolCall("foreign_call", "web_fetch"),
          toolCall("legacy_call", "read"),
          toolCall("signed_call", "read", "SIG-EXACT-SAME-ROUTE=="),
        ]),
      ],
    );
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: expect.stringContaining("[Historical tool call: web_fetch("),
    });
    expect(messages[0]).not.toHaveProperty("tool_calls");
    expect(messages.slice(1, 4)).toEqual([
      { role: "user", content: "[Historical tool result for web_fetch:\nforeign result]" },
      { role: "user", content: "[Historical tool result for read:\nlegacy result]" },
      { role: "user", content: "[Historical tool result for read:\nsigned result]" },
    ]);
    expect(messages[4]).toEqual({ role: "user", content: "current prompt" });
  });

  it("pairs reused Gemini tool-call ids by assistant occurrence", async () => {
    function payload(readResult: string, writeResult: string) {
      return {
        model: GEMINI_MODEL,
        messages: [
          wireAssistant(wireCall("call_0", "read", "{}")),
          wireResult("call_0", readResult),
          wireAssistant(wireCall("call_0", "write", "{}")),
          wireResult("call_0", writeResult),
          { role: "user", content: "current prompt" },
        ],
      };
    }
    const signed = await patchPayload(payload("read result", "write result"), [
      assistant([toolCall("call_0", "read", "SIG-READ")]),
      assistant([toolCall("call_0", "write", "SIG-WRITE")]),
    ]);
    expect(signed.messages[0]).toMatchObject({
      tool_calls: [{ id: "call_0", thought_signature: "SIG-READ" }],
    });
    expect(signed.messages[2]).toMatchObject({
      tool_calls: [{ id: "call_0", thought_signature: "SIG-WRITE" }],
    });

    const mixed = await patchPayload(payload("legacy result", "signed result"), [
      assistant([toolCall("call_0", "read")]),
      assistant([toolCall("call_0", "write", "SIG-WRITE")]),
    ]);
    expect(mixed.messages[0]).toMatchObject({
      role: "assistant",
      content: expect.stringContaining("[Historical tool call: read("),
    });
    expect(mixed.messages[0]).not.toHaveProperty("tool_calls");
    expect(mixed.messages[1]).toEqual({
      role: "user",
      content: "[Historical tool result for read:\nlegacy result]",
    });
    expect(mixed.messages[2]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "call_0", thought_signature: "SIG-WRITE" }],
    });
    expect(mixed.messages[3]).toEqual(wireResult("call_0", "signed result"));
  });

  it("leaves unsigned Gemini 2.5 history unchanged", async () => {
    const payload = {
      model: "gemini-2.5-flash",
      messages: [wireAssistant(wireCall("call_1", "read"))],
    };
    expect(await patchPayload(structuredClone(payload))).toEqual(payload);
  });
});
