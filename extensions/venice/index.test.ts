import {
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { captureProviderRequestPayload } from "../test-support/provider-request-payload.test-support.js";
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

function call(...details: [id: string, name: string, result: string, signature?: string]) {
  return details;
}

function wireAssistant(...calls: [id: string, name: string, args?: string][]) {
  return {
    role: "assistant",
    tool_calls: calls.map(([id, name, args]) => ({
      id,
      type: "function",
      function: { name, ...(args === undefined ? {} : { arguments: args }) },
    })),
  };
}

function wireResult(id: string, content: string) {
  return { role: "tool", tool_call_id: id, content };
}

function expectTextHistory(messages: Record<string, unknown>[], name: string, result: string) {
  expect(messages.slice(0, 2)).toEqual([
    { role: "assistant", content: expect.stringContaining(`[Historical tool call: ${name}(`) },
    { role: "user", content: `[Historical tool result for ${name}:\n${result}]` },
  ]);
}

async function patchPayload(
  payload: { model: string; messages: Record<string, unknown>[] } & Record<string, unknown>,
  messages: Context["messages"] = [],
) {
  const provider = await registerSingleProviderPlugin(plugin);
  const streamFn = provider.wrapStreamFn!({
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
  await streamFn!(veniceModel(payload.model), { messages }, {});
  return payload;
}

async function patchGemini(
  batches: ReturnType<typeof call>[][],
  args?: string,
  route: Partial<Pick<AssistantMessage, "api" | "provider" | "model">> = {},
) {
  const messages: Record<string, unknown>[] = batches.flatMap((calls) => [
    wireAssistant(...calls.map(([id, name]): [string, string, string?] => [id, name, args])),
    ...calls.map(([id, , result]) => wireResult(id, result)),
  ]);
  messages.push({ role: "user", content: "current prompt" });
  const history: Context["messages"] = [
    { role: "user", content: "echo", timestamp: 0 },
    ...batches.map((calls) =>
      makeAgentAssistantMessage({
        api: "openai-completions",
        provider: "venice",
        model: GEMINI_MODEL,
        stopReason: "toolUse",
        content: calls.map(([id, name, , thoughtSignature]) => ({
          type: "toolCall" as const,
          id,
          name,
          arguments: {},
          thoughtSignature,
        })),
        ...route,
      }),
    ),
  ];
  return (await patchPayload({ model: GEMINI_MODEL, messages }, history)).messages;
}

it.each([
  { baseUrl: "https://api.venice.ai/api/v1", expected: "synthetic-session" },
  { baseUrl: "https://proxy.example/v1", expected: undefined },
  { baseUrl: "https://api.venice.ai/api/v1", optOut: true, expected: undefined },
])("sends cache affinity only for native enabled requests: $baseUrl, $optOut", async (route) => {
  const provider = await registerSingleProviderPlugin(plugin);
  const model: Model = {
    ...veniceModel("synthetic-model"),
    baseUrl: route.baseUrl,
    ...(route.optOut ? { compat: { supportsPromptCacheKey: false } } : {}),
  };
  const normalized =
    provider.normalizeResolvedModel?.({ provider: model.provider, modelId: model.id, model }) ??
    model;
  const { result, payload } = await captureProviderRequestPayload(normalized);
  expect(result.errorMessage).toBe("captured before request");
  expect(payload).toMatchObject({ prompt_cache_key: route.expected });
  expect(payload).not.toHaveProperty("prompt_cache_retention");
  expect(payload).not.toHaveProperty("prompt_cache_options");
});

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
    messages: [wireAssistant(["call_1", "read", "{}"]), { role: "assistant", content: "done" }],
  });
  expect(payload).toEqual({
    model: "deepseek-v4-pro",
    messages: [
      { ...wireAssistant(["call_1", "read", "{}"]), reasoning_content: "" },
      { role: "assistant", content: "done", reasoning_content: "" },
    ],
  });
});

it.each([
  {
    history: "foreign-route",
    calls: [call("call_1", "echo_value", "ok", "SIG-CROSS-ROUTE")],
    args: '{"value":"repro"}',
    route: { api: "google-generative-ai" as const, provider: "google" },
  },
  {
    history: "mixed-signature",
    calls: [
      call("foreign_call", "web_fetch", "foreign result"),
      call("legacy_call", "read", "legacy result"),
      call("signed_call", "read", "signed result", "SIG-EXACT-SAME-ROUTE=="),
    ],
  },
])("downgrades $history Gemini batches to text", async ({ calls, args, route }) => {
  const messages = await patchGemini([calls], args, route);
  const [, firstName, firstResult] = calls[0]!;
  expectTextHistory(messages, firstName, firstResult);
  expect(messages.slice(2, -1)).toEqual(
    calls.slice(1).map(([, name, result]) => ({
      role: "user",
      content: `[Historical tool result for ${name}:\n${result}]`,
    })),
  );
  expect(messages.at(-1)).toEqual({ role: "user", content: "current prompt" });
});

it.each(["SIG-READ", undefined])("pairs reused Gemini tool-call ids: %s", async (signature) => {
  const messages = await patchGemini(
    [
      [call("call_0", "read", "read result", signature)],
      [call("call_0", "write", "write result", "SIG-WRITE")],
    ],
    "{}",
  );
  if (signature) {
    expect(messages[0]).toMatchObject({
      tool_calls: [{ id: "call_0", thought_signature: signature }],
    });
    expect(messages[0]).not.toHaveProperty("tool_calls.0.extra_content");
  } else {
    expectTextHistory(messages, "read", "read result");
  }
  expect(messages[2]).toMatchObject({
    role: "assistant",
    tool_calls: [{ id: "call_0", thought_signature: "SIG-WRITE" }],
  });
  expect(messages[3]).toEqual(wireResult("call_0", "write result"));
});

it("leaves unsigned Gemini 2.5 history unchanged", async () => {
  const payload = {
    model: "gemini-2.5-flash",
    messages: [wireAssistant(["call_1", "read"])],
  };
  expect(await patchPayload(structuredClone(payload))).toEqual(payload);
});
