import type { ProviderNormalizeResolvedModelContext } from "openclaw/plugin-sdk/plugin-entry";
import type { ModelApi } from "openclaw/plugin-sdk/provider-model-types";
import { describe, expect, it } from "vitest";
import { projectConfiguredModelRow } from "./provider-policy-api.js";

function createProjectionContext(params?: {
  modelId?: string;
  rowApi?: ModelApi;
  rowBaseUrl?: string;
  providerApi?: ModelApi;
  configuredModelApi?: ModelApi;
}): ProviderNormalizeResolvedModelContext {
  const modelId = params?.modelId ?? "gpt-5.5";
  const model = {
    provider: "openai",
    id: modelId,
    api: params?.rowApi ?? ("openai-responses" as const),
    baseUrl: params?.rowBaseUrl ?? "https://api.openai.com/v1",
    input: ["text" as const],
    name: "OpenAI model",
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 96_000,
    maxTokens: 128_000,
  };
  const context: ProviderNormalizeResolvedModelContext = {
    provider: "openai",
    modelId,
    model,
  };
  if (params?.providerApi) {
    const openai = {
      api: params.providerApi,
      baseUrl: "https://api.openai.com/v1",
      models: [{ ...model, api: params.configuredModelApi }],
    };
    context.config = { models: { providers: { openai } } };
  }
  return context;
}

describe("OpenAI configured-row projection", () => {
  it("skips runtime normalization for canonical Responses rows", () => {
    expect(projectConfiguredModelRow(createProjectionContext())).toBeNull();
  });

  it.each([
    ["provider", "openai-completions", undefined, undefined],
    ["model", "openai-responses", "openai-completions", "openai-completions"],
    ["provider ChatGPT", "openai-chatgpt-responses", undefined, undefined],
  ] as const)(
    "keeps runtime normalization for a %s configured route",
    (_source, providerApi, configuredModelApi, rowApi) => {
      expect(
        projectConfiguredModelRow(
          createProjectionContext({ providerApi, configuredModelApi, rowApi }),
        ),
      ).toBeUndefined();
    },
  );

  it.each([
    ["openai-completions", "https://api.openai.com/v1", "gpt-5.5"],
    ["openai-chatgpt-responses", "https://chatgpt.com/backend-api/codex", "gpt-5.5"],
    ["openai-responses", "https://chatgpt.com/backend-api/codex", "gpt-5.5"],
    ["openai-responses", "https://api.openai.com/v1", "gpt-5.4-codex"],
  ] as const)(
    "keeps runtime normalization for api=%s baseUrl=%s model=%s",
    (rowApi, rowBaseUrl, modelId) => {
      expect(
        projectConfiguredModelRow(createProjectionContext({ modelId, rowApi, rowBaseUrl })),
      ).toBeUndefined();
    },
  );
});
