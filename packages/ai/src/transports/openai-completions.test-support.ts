import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { expect } from "vitest";
import {
  configureAiTransportHost,
  getAiTransportHost,
  type AiProviderRequestCapabilities,
  type AiProviderRequestPolicyInput,
} from "../host.js";
import type { Model } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { encodedModelRequestBodyStream } from "./model-request-body.js";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import type { processCompletionsStream } from "./openai-completions-stream.js";

export type OpenAICompletionsOutput = Parameters<typeof processCompletionsStream>[1];

export type CapturedStreamEvent = {
  type?: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  partial?: unknown;
};

function resolveTestEndpointClass(baseUrl: string | undefined): string {
  if (!baseUrl) {
    return "default";
  }
  const host = new URL(baseUrl).hostname;
  const exactClasses: Record<string, string> = {
    "api.openai.com": "openai-public",
    "api.cerebras.ai": "cerebras-native",
    "api.x.ai": "xai-native",
    "api.moonshot.ai": "moonshot-native",
    "api.moonshot.cn": "moonshot-native",
    "llm.chutes.ai": "chutes-native",
    "api.z.ai": "zai-native",
    "api.deepseek.com": "deepseek-native",
    "api.mistral.ai": "mistral-public",
    "dashscope.aliyuncs.com": "modelstudio-native",
    "generativelanguage.googleapis.com": "google-generative-ai",
    "127.0.0.1": "local",
    localhost: "local",
  };
  const suffixClasses: Record<string, string> = {
    ".openai.azure.com": "azure-openai",
    ".services.ai.azure.com": "azure-openai",
    ".cognitiveservices.azure.com": "azure-openai",
    "openrouter.ai": "openrouter",
    "opencode.ai": "opencode-native",
    "xiaomimimo.com": "xiaomi-native",
    "aiplatform.googleapis.com": "google-vertex",
  };
  return (
    exactClasses[host] ??
    Object.entries(suffixClasses).find(([suffix]) => host.endsWith(suffix))?.[1] ??
    "custom"
  );
}

function resolveTestCapabilities(
  input: AiProviderRequestPolicyInput,
): AiProviderRequestCapabilities {
  const endpointClass = resolveTestEndpointClass(input.baseUrl);
  const provider = input.provider ?? "unknown";
  const families = new Map([
    ["moonshotai", "moonshot"],
    ["moonshotai-cn", "moonshot"],
    ["dashscope", "modelstudio"],
    ["modelstudio", "modelstudio"],
    ["qwen", "modelstudio"],
    ["openai", "openai-family"],
    ["azure-openai", "openai-family"],
  ]);
  return {
    endpointClass,
    knownProviderFamily: families.get(provider) ?? provider,
    supportsNativeStreamingUsageCompat:
      endpointClass === "moonshot-native" || endpointClass === "modelstudio-native",
    supportsOpenAICompletionsStreamingUsageCompat: provider === "volcengine-plan",
    usesExplicitProxyLikeEndpoint: !["default", "openai-public", "openai", "azure-openai"].includes(
      endpointClass,
    ),
    allowsAnthropicServiceTier: false,
  };
}

const baseTestHost = getAiTransportHost();
configureAiTransportHost({
  ...baseTestHost,
  buildModelFetch: () => async (input, init) => {
    const response = await globalThis.fetch(input, init);
    const contentType = response.headers.get("content-type") ?? "";
    if (
      !response.ok ||
      !response.body ||
      !contentType.includes("application/json") ||
      encodedModelRequestBodyStream(init?.body) === false
    ) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.set("content-type", "text/event-stream; charset=utf-8");
    return new Response(`data: ${await response.text()}\n\ndata: [DONE]\n\n`, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
  resolveOpenAIStrictToolSetting: (_model, options) =>
    options?.supportsStrictMode ? true : undefined,
  resolveProviderRequestCapabilities: resolveTestCapabilities,
  resolveModelRequestTimeoutMs: (model) => {
    const value = (model as { requestTimeoutMs?: unknown }).requestTimeoutMs;
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : undefined;
  },
});

export function makeCompletionsModel(
  overrides: Partial<Model<"openai-completions">> = {},
): Model<"openai-completions"> {
  const id = overrides.id ?? "test-model";
  return {
    id,
    name: overrides.name ?? id,
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...overrides,
  };
}
function namedModel(
  id: string,
  name: string,
  overrides: Partial<Model<"openai-completions">> = {},
) {
  return makeCompletionsModel({ ...overrides, id, name });
}

export function makeCompletionsChunk(
  delta: unknown,
  finishReason: unknown = null,
  overrides: Record<string, unknown> = {},
): ChatCompletionChunk {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [
      {
        index: 0,
        delta: delta as ChatCompletionChunk["choices"][number]["delta"],
        logprobs: null,
        finish_reason: finishReason as ChatCompletionChunk["choices"][number]["finish_reason"],
      },
    ],
    ...overrides,
  } as ChatCompletionChunk;
}

export function createDeepSeekCompletionsModel(): Model<"openai-completions"> {
  return namedModel("deepseek-v4-pro", "DeepSeek V4 Pro", {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    compat: { thinkingFormat: "deepseek" },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
  });
}

export function createAssistantOutput(model: Model<"openai-completions">): OpenAICompletionsOutput {
  return {
    role: "assistant" as const,
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export async function* streamChunks(chunks: readonly unknown[]): AsyncGenerator<never> {
  for (const chunk of chunks) {
    yield chunk as never;
  }
}

export function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

export const openRouterModel = namedModel("deepseek/deepseek-v4-flash", "DeepSeek v4 Flash", {
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  contextWindow: 128_000,
});

export const openRouterAnthropicModel = namedModel(
  "anthropic/claude-sonnet-4.6",
  "Claude Sonnet 4.6",
  openRouterModel,
);

export const openRouterXaiModel = namedModel("x-ai/grok-4.3", "Grok 4.3", openRouterModel);

export const openAIModel = namedModel("gpt-5.4-mini", "GPT-5.4 Mini");

export const nativeDeepSeekModel = namedModel("deepseek-v4-flash", "DeepSeek V4 Flash", {
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  contextWindow: 1_000_000,
  maxTokens: 384_000,
});

export const nativeZaiModel = namedModel("glm-5.1", "GLM 5.1", {
  provider: "zai",
  baseUrl: "https://api.z.ai/api/paas/v4",
  maxTokens: 131_072,
});

export const xiaomiModel = namedModel("mimo-v2.5-pro", "MiMo V2.5 Pro", {
  provider: "xiaomi",
  baseUrl: "https://api.xiaomimimo.com/v1",
  contextWindow: 1_048_576,
  maxTokens: 32_000,
});

export const customMiMoProxyModel = makeCompletionsModel({
  ...xiaomiModel,
  provider: "xiaomi-orbit",
  baseUrl: "https://proxy.example.com/v1",
});

export const customKimiProxyModel = namedModel("moonshotai/kimi-k2.6", "Kimi K2.6", {
  provider: "custom-openai-proxy",
  baseUrl: "https://proxy.example.com/v1",
  contextWindow: 262_144,
  maxTokens: 32_000,
});

export const staleKimiK27Model = namedModel("kimi-k2.7-code", "Kimi K2.7 Code", {
  ...customKimiProxyModel,
  provider: "moonshot",
  baseUrl: "https://api.moonshot.ai/v1",
  reasoning: false,
});

export const customQwenReasoningModel = namedModel(
  "Qwen3.6-35B-A3B",
  "Qwen3.6 35B",
  customKimiProxyModel,
);

export function getAssistantMessage(params: { messages: unknown }) {
  expect(Array.isArray(params.messages)).toBe(true);
  const list = params.messages as Array<Record<string, unknown>>;
  const assistant = list.find((message) => message.role === "assistant");
  expect(assistant).toBeDefined();
  return assistant as Record<string, unknown>;
}

export function buildReplayParams(model: Model<"openai-completions">, thinkingSignature: string) {
  return buildOpenAICompletionsParams(
    model,
    {
      systemPrompt: "system",
      messages: [
        { role: "user", content: "hello" },
        {
          ...createAssistantOutput(model),
          timestamp: 0,
          content: [
            {
              type: "thinking",
              thinking: "Need to answer politely.",
              thinkingSignature,
            },
            { type: "text", text: "Hello!" },
          ],
        },
        { role: "user", content: "again" },
      ],
      tools: [],
    } as never,
    undefined,
  ) as { messages: unknown };
}

export const customReasoningProxyModel = namedModel("my-proxy/r1-pro", "Custom Reasoning Proxy", {
  provider: "custom-openai-proxy",
  baseUrl: "https://my-proxy.example.com/v1",
});
