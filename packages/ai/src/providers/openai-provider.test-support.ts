import { afterEach, beforeEach } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import type { Api, Model } from "../types.js";

export function makeOpenAIProviderModel<TApi extends Api>(
  api: TApi,
  overrides: Partial<Model<TApi>> = {},
): Model<TApi> {
  return {
    id: "gpt-5.5",
    name: "GPT-5.5",
    api,
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
    ...overrides,
  };
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
