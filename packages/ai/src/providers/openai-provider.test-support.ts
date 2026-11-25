import { afterEach, beforeEach } from "vitest";
import {
  configureAiTransportHost,
  getAiTransportHost,
  type AiProviderRequestCapabilities,
  type AiProviderRequestPolicyInput,
} from "../host.js";
import type { Api, Model } from "../types.js";
import { makeProviderModel } from "./provider-model.test-support.js";

function resolveTestEndpointClass(baseUrl: string | undefined): string {
  if (!baseUrl) {
    return "default";
  }
  const host = new URL(baseUrl).hostname;
  const classes: [RegExp, string][] = [
    [/^api\.openai\.com$/, "openai-public"],
    [/^api\.cerebras\.ai$/, "cerebras-native"],
    [/^api\.x\.ai$/, "xai-native"],
    [/^api\.moonshot\.(ai|cn)$/, "moonshot-native"],
    [/^llm\.chutes\.ai$/, "chutes-native"],
    [/^api\.z\.ai$/, "zai-native"],
    [/^api\.deepseek\.com$/, "deepseek-native"],
    [/^api\.mistral\.ai$/, "mistral-public"],
    [/^dashscope\.aliyuncs\.com$/, "modelstudio-native"],
    [/^generativelanguage\.googleapis\.com$/, "google-generative-ai"],
    [/^(127\.0\.0\.1|localhost)$/, "local"],
    [/\.(openai\.azure|services\.ai\.azure|cognitiveservices\.azure)\.com$/, "azure-openai"],
    [/openrouter\.ai$/, "openrouter"],
    [/opencode\.ai$/, "opencode-native"],
    [/xiaomimimo\.com$/, "xiaomi-native"],
    [/aiplatform\.googleapis\.com$/, "google-vertex"],
  ];
  return classes.find(([pattern]) => pattern.test(host))?.[1] ?? "custom";
}

export function resolveTestOpenAIProviderCapabilities(
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

export function makeOpenAIProviderModel<TApi extends Api>(
  api: TApi,
  overrides: Partial<Model<TApi>> = {},
): Model<TApi> {
  return makeProviderModel(api, "openai", "gpt-5.5", {
    name: "GPT-5.5",
    baseUrl: "https://api.openai.com/v1",
    maxTokens: 4_096,
    ...overrides,
  });
}

export function preserveTransportHost() {
  let previousHost: ReturnType<typeof getAiTransportHost>;
  beforeEach(() => {
    previousHost = getAiTransportHost();
  });
  afterEach(() => {
    configureAiTransportHost(previousHost);
  });
}
