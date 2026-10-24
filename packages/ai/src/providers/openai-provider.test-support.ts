import { afterEach, beforeEach } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import type { Api, Model } from "../types.js";
import { makeProviderModel } from "./provider-model.test-support.js";

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
