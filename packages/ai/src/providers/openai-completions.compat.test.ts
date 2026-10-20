import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureAiTransportHost,
  getAiTransportHost,
  type AiProviderRequestCapabilities,
  type AiProviderRequestPolicyInput,
} from "../host.js";
import type { Context, Model } from "../types.js";

const mockOpenAI = vi.hoisted(() => ({
  chunks: [] as unknown[],
  clientOptions: [] as unknown[],
  payloads: [] as unknown[],
  requestOptions: [] as unknown[],
  nextError: undefined as Error | undefined,
}));

vi.mock("openai", () => {
  class MockOpenAI {
    constructor(options: unknown) {
      mockOpenAI.clientOptions.push(options);
    }

    chat = {
      completions: {
        create: (payload: unknown, requestOptions: unknown) => {
          mockOpenAI.payloads.push(payload);
          mockOpenAI.requestOptions.push(requestOptions);
          async function* stream() {
            yield* mockOpenAI.chunks;
          }
          return Object.assign(Promise.resolve(stream()), {
            asResponse: async () => {
              if (mockOpenAI.nextError !== undefined) {
                throw mockOpenAI.nextError;
              }
              return new Response(null, { status: 200 });
            },
          });
        },
      },
    };
  }

  return { default: MockOpenAI };
});

import {
  resolveOpenAICompletionsCompat,
  type ResolvedOpenAICompletionsCompat,
} from "../transports/openai-completions-compat.js";
import { streamOpenAICompletions } from "./openai-completions.js";

const baseModel: Model<"openai-completions"> = {
  id: "test-model",
  name: "Test model",
  api: "openai-completions",
  provider: "custom-openai-compatible",
  baseUrl: "https://proxy.example/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

const userMessage = { role: "user", content: "hello", timestamp: 1 } as const;
const context: Context = { messages: [userMessage] };
let previousAiTransportHost: ReturnType<typeof getAiTransportHost>;

function createModel(overrides: Partial<Model<"openai-completions">> = {}) {
  return { ...baseModel, ...overrides };
}

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
    "dashscope.aliyuncs.com": "modelstudio-native",
    "127.0.0.1": "local",
    localhost: "local",
  };
  const exactClass = exactClasses[host];
  if (exactClass) {
    return exactClass;
  }
  if (host.endsWith(".openai.azure.com")) {
    return "azure-openai";
  }
  if (host.endsWith("openrouter.ai")) {
    return "openrouter";
  }
  if (host.endsWith("opencode.ai")) {
    return "opencode-native";
  }
  if (host.endsWith("xiaomimimo.com")) {
    return "xiaomi-native";
  }
  return "custom";
}

function resolveTestCapabilities(
  input: AiProviderRequestPolicyInput,
): AiProviderRequestCapabilities {
  const endpointClass = resolveTestEndpointClass(input.baseUrl);
  const provider = input.provider;
  const knownProviderFamily =
    provider === "moonshotai" || provider === "moonshotai-cn"
      ? "moonshot"
      : provider === "openai" || provider === "azure-openai"
        ? "openai-family"
        : provider === "qwen" || provider === "dashscope"
          ? "modelstudio"
          : (provider ?? "unknown");
  const usesConfiguredBaseUrl = endpointClass !== "default";
  const usesKnownNativeOpenAIEndpoint =
    endpointClass === "openai-public" ||
    endpointClass === "openai" ||
    endpointClass === "azure-openai";
  return {
    endpointClass,
    knownProviderFamily,
    supportsNativeStreamingUsageCompat: endpointClass === "moonshot-native",
    supportsOpenAICompletionsStreamingUsageCompat: false,
    usesExplicitProxyLikeEndpoint: usesConfiguredBaseUrl && !usesKnownNativeOpenAIEndpoint,
    allowsAnthropicServiceTier: false,
  };
}

type DuplicatedCompatFields = Pick<
  ResolvedOpenAICompletionsCompat,
  | "supportsStore"
  | "supportsDeveloperRole"
  | "supportsReasoningEffort"
  | "maxTokensField"
  | "thinkingFormat"
  | "supportsStrictMode"
  | "supportsJsonSchemaResponseFormat"
>;

const defaultDuplicatedCompat = {
  supportsStore: true,
  supportsDeveloperRole: true,
  supportsReasoningEffort: true,
  maxTokensField: "max_completion_tokens",
  thinkingFormat: "openai",
  supportsStrictMode: true,
  supportsJsonSchemaResponseFormat: false,
} satisfies DuplicatedCompatFields;

function duplicatedCompatFields(compat: ResolvedOpenAICompletionsCompat): DuplicatedCompatFields {
  return {
    supportsStore: compat.supportsStore,
    supportsDeveloperRole: compat.supportsDeveloperRole,
    supportsReasoningEffort: compat.supportsReasoningEffort,
    maxTokensField: compat.maxTokensField,
    thinkingFormat: compat.thinkingFormat,
    supportsStrictMode: compat.supportsStrictMode,
    supportsJsonSchemaResponseFormat: compat.supportsJsonSchemaResponseFormat,
  };
}

const canonicalProxyCompat = {
  ...defaultDuplicatedCompat,
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsStrictMode: false,
} satisfies DuplicatedCompatFields;
const canonicalOpenRouterCompat = {
  ...canonicalProxyCompat,
  thinkingFormat: "openrouter",
} satisfies DuplicatedCompatFields;
const canonicalChutesCompat = {
  ...canonicalProxyCompat,
  maxTokensField: "max_tokens",
} satisfies DuplicatedCompatFields;
const canonicalTogetherCompat = {
  ...canonicalChutesCompat,
  thinkingFormat: "together",
} satisfies DuplicatedCompatFields;

type MatrixParityCase = readonly [
  name: string,
  overrides: Partial<Model<"openai-completions">>,
  expected: DuplicatedCompatFields,
];

const legacyMatrixParityCases = [
  [
    "OpenRouter Anthropic model",
    { provider: "openrouter", id: "anthropic/claude-sonnet-4.6" },
    canonicalOpenRouterCompat,
  ],
  [
    "endpoint together.xyz",
    { provider: "custom", baseUrl: "https://api.together.xyz/v1" },
    canonicalTogetherCompat,
  ],
] satisfies MatrixParityCase[];

function chunk(delta: Record<string, unknown>, finishReason?: string): unknown {
  return {
    id: "chatcmpl-test",
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  };
}

beforeEach(() => {
  previousAiTransportHost = getAiTransportHost();
  configureAiTransportHost({ resolveProviderRequestCapabilities: resolveTestCapabilities });
  mockOpenAI.chunks = [chunk({ content: "ok" }), chunk({}, "stop")];
  mockOpenAI.clientOptions = [];
  mockOpenAI.payloads = [];
  mockOpenAI.requestOptions = [];
  mockOpenAI.nextError = undefined;
});

afterEach(() => {
  configureAiTransportHost(previousAiTransportHost);
});

describe("OpenAI-compatible completions compatibility", () => {
  it.each(legacyMatrixParityCases)(
    "maps former provider matrix case %s to canonical endpoint policy",
    (_name, overrides, expected) => {
      expect(
        duplicatedCompatFields(resolveOpenAICompletionsCompat(createModel(overrides))),
      ).toEqual(expected);
    },
  );

  it("buffers encrypted reasoning details until their tool call arrives", async () => {
    const reasoningDetail = {
      type: "reasoning.encrypted",
      id: "call_1",
      data: "encrypted-signature",
    };
    mockOpenAI.chunks = [
      chunk({ reasoning_details: [reasoningDetail] }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"cats"}' },
          },
        ],
      }),
      chunk({}, "tool_calls"),
    ];
    const model = createModel({
      id: "google/gemini-test",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
    });

    const result = await streamOpenAICompletions(model, context, {
      apiKey: "test",
    }).result();

    expect(result.content.find((block) => block.type === "toolCall")).toMatchObject({
      id: "call_1",
      thoughtSignature: JSON.stringify(reasoningDetail),
    });

    let replayPayload: unknown;
    await streamOpenAICompletions(
      model,
      {
        messages: [result],
        tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
      },
      {
        apiKey: "test",
        onPayload(payload) {
          replayPayload = payload;
          throw new Error("payload captured");
        },
      },
    ).result();
    const replayedAssistant = (
      replayPayload as { messages?: Array<{ role?: string; reasoning_details?: unknown }> }
    ).messages?.find((message) => message.role === "assistant");
    expect(replayedAssistant?.reasoning_details).toEqual([reasoningDetail]);
  });

  it("sends configured OpenRouter routing through a compatible proxy", async () => {
    let payload: unknown;
    const routing = { only: ["google-vertex"] };
    const model = createModel({ compat: { openRouterRouting: routing } });

    await streamOpenAICompletions(model, context, {
      apiKey: "test",
      onPayload(nextPayload) {
        payload = nextPayload;
        throw new Error("payload captured");
      },
    }).result();

    expect((payload as { provider?: unknown }).provider).toEqual(routing);
  });

  it.each([
    {
      name: "OpenAI",
      model: createModel({
        headers: { Authorization: "Bearer proxy-key" },
        compat: { sendSessionAffinityHeaders: true },
      }),
      expectedHeaders: {
        Authorization: "Bearer proxy-key",
        session_id: "session-123",
        "x-client-request-id": "session-123",
        "x-session-affinity": "session-123",
      },
    },
    {
      name: "OpenRouter-compatible proxy",
      model: createModel({
        compat: {
          sendSessionAffinityHeaders: true,
          thinkingFormat: "openrouter",
        },
      }),
      expectedHeaders: { "x-session-id": "session-123" },
    },
    {
      name: "OpenCode Zen",
      model: createModel({ baseUrl: "https://opencode.ai/zen/v1" }),
      expectedHeaders: { "x-opencode-session": "session-123" },
    },
  ])(
    "sends exact $name session-affinity headers",
    async ({ model, expectedHeaders, ...testCase }) => {
      await streamOpenAICompletions(model, context, {
        apiKey: "test",
        sessionId: "session-123",
        ...testCase,
      }).result();

      const clientOptions = mockOpenAI.clientOptions[0] as {
        defaultHeaders?: Record<string, string>;
      };
      expect(mockOpenAI.clientOptions).toHaveLength(1);
      expect(mockOpenAI.clientOptions[0]).toMatchObject({ apiKey: "test" });
      expect(clientOptions.defaultHeaders).toEqual(expectedHeaders);
    },
  );

  it("redacts OpenRouter terminal body and raw metadata from one error projection", async () => {
    const media = "QUJDRA==";
    mockOpenAI.nextError = Object.assign(new Error("400 status code (no body)"), {
      status: 400,
      body: { data: [{ b64_json: media }] },
      error: {
        code: "bad_image",
        type: "invalid_request_error",
        metadata: { raw: `render failed data:image/png;base64,${media}` },
      },
    });

    const result = await streamOpenAICompletions(baseModel, context, { apiKey: "test" }).result();

    expect(result).toMatchObject({
      errorCode: "bad_image",
      errorType: "invalid_request_error",
    });
    expect(JSON.stringify(result)).not.toContain(media);
  });
});
