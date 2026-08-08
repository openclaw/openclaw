import type { ProviderNormalizeResolvedModelContext } from "openclaw/plugin-sdk/plugin-entry";
import type { ModelApi, ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeConfig, projectConfiguredModelRow } from "./provider-policy-api.js";

function createProjectionContext(params?: {
  modelId?: string;
  rowApi?: ModelApi;
  rowBaseUrl?: string;
  providerApi?: ModelApi;
  configuredModelApi?: ModelApi;
}): ProviderNormalizeResolvedModelContext {
  const modelId = params?.modelId ?? "gpt-5.5";
  return {
    provider: "openai",
    modelId,
    ...(params?.providerApi
      ? {
          config: {
            models: {
              providers: {
                openai: {
                  api: params.providerApi,
                  baseUrl: "https://api.openai.com/v1",
                  models: [
                    {
                      id: modelId,
                      name: "Configured OpenAI model",
                      reasoning: true,
                      input: ["text" as const],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 96_000,
                      maxTokens: 128_000,
                      ...(params.configuredModelApi ? { api: params.configuredModelApi } : {}),
                    },
                  ],
                },
              },
            },
          },
        }
      : {}),
    model: {
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
    },
  };
}

describe("OpenAI configured-row projection", () => {
  it("skips runtime normalization for canonical Responses rows", () => {
    expect(projectConfiguredModelRow(createProjectionContext())).toBeNull();
  });

  it("removes falsely advertised video before bypassing first-party runtime normalization", () => {
    const context = createProjectionContext();
    context.model.input = ["text", "image", "video"];

    expect(projectConfiguredModelRow(context)).toMatchObject({
      input: ["text", "image"],
    });
  });

  it("keeps declared video on custom OpenAI-compatible Responses routes", () => {
    const context = createProjectionContext({ rowBaseUrl: "https://video.example.test/v1" });
    context.model.input = ["text", "image", "video"];

    expect(projectConfiguredModelRow(context)).toBeNull();
  });

  it.each([
    {
      source: "provider",
      providerApi: "openai-completions" as const,
      configuredModelApi: undefined,
      rowApi: undefined,
    },
    {
      source: "model",
      providerApi: "openai-responses" as const,
      configuredModelApi: "openai-completions" as const,
      rowApi: "openai-completions" as const,
    },
    {
      source: "provider ChatGPT",
      providerApi: "openai-chatgpt-responses" as const,
      configuredModelApi: undefined,
      rowApi: undefined,
    },
  ])(
    "keeps runtime normalization for a $source configured route",
    ({ providerApi, configuredModelApi, rowApi }) => {
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
    ["anthropic-messages", "https://api.openai.com/v1", "gpt-5.5"],
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

describe("OpenAI configured native-video capabilities", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    {
      name: "the default OpenAI Platform endpoint",
      providerApi: "openai-responses" as const,
      supportsVideo: false,
    },
    {
      name: "an explicit OpenAI Platform endpoint",
      providerApi: "openai-completions" as const,
      providerBaseUrl: "https://api.openai.com/v1",
      supportsVideo: false,
    },
    {
      name: "the ChatGPT endpoint",
      providerApi: "openai-chatgpt-responses" as const,
      providerBaseUrl: "https://chatgpt.com/backend-api/codex",
      supportsVideo: false,
    },
    {
      name: "ChatGPT transport on an explicitly configured relay",
      providerApi: "openai-chatgpt-responses" as const,
      providerBaseUrl: "https://video.example.test/v1",
      supportsVideo: false,
    },
    {
      name: "a custom OpenAI-compatible provider endpoint",
      providerApi: "openai-completions" as const,
      providerBaseUrl: "https://video.example.test/v1",
      supportsVideo: true,
    },
    {
      name: "a custom model endpoint overriding the first-party provider",
      providerApi: "openai-responses" as const,
      providerBaseUrl: "https://api.openai.com/v1",
      modelBaseUrl: "https://video.example.test/v1",
      supportsVideo: true,
    },
    {
      name: "a first-party model endpoint overriding a custom provider",
      providerApi: "openai-completions" as const,
      providerBaseUrl: "https://video.example.test/v1",
      modelBaseUrl: "https://api.openai.com/v1",
      supportsVideo: false,
    },
    {
      name: "an environment-only custom OpenAI-compatible endpoint",
      providerApi: "openai-responses" as const,
      environmentBaseUrl: "https://video.example.test/v1",
      supportsVideo: true,
    },
    {
      name: "a first-party model endpoint overriding a custom environment endpoint",
      providerApi: "openai-responses" as const,
      environmentBaseUrl: "https://video.example.test/v1",
      modelBaseUrl: "https://api.openai.com/v1",
      supportsVideo: false,
    },
    {
      name: "a model-level ChatGPT adapter overriding a custom provider",
      providerApi: "openai-responses" as const,
      providerBaseUrl: "https://video.example.test/v1",
      modelApi: "openai-chatgpt-responses" as const,
      supportsVideo: false,
    },
  ])(
    "keeps provider-owned capability truth for $name",
    ({
      providerApi,
      providerBaseUrl,
      modelApi,
      modelBaseUrl,
      environmentBaseUrl,
      supportsVideo,
    }) => {
      vi.stubEnv("OPENAI_BASE_URL", environmentBaseUrl ?? "");
      const configuredProvider = {
        api: providerApi,
        baseUrl: providerBaseUrl ?? "",
        models: [
          {
            id: "gpt-5.5",
            name: "Configured model",
            reasoning: true,
            input: ["text", "image", "video", "audio"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 96_000,
            maxTokens: 128_000,
            ...(modelApi ? { api: modelApi } : {}),
            ...(modelBaseUrl ? { baseUrl: modelBaseUrl } : {}),
          },
        ],
      } satisfies ModelProviderConfig;

      const normalized = normalizeConfig({
        provider: "openai",
        providerConfig: configuredProvider,
      });

      expect(normalized.models[0]?.input).toEqual(
        supportsVideo ? ["text", "image", "video", "audio"] : ["text", "image", "audio"],
      );
      expect(normalized === configuredProvider).toBe(supportsVideo);
    },
  );

  it("does not apply OpenAI policy to another provider", () => {
    const configuredProvider = {
      api: "openai-completions",
      baseUrl: "https://api.moonshot.ai/v1",
      models: [
        {
          id: "kimi-k3",
          name: "Kimi K3",
          reasoning: true,
          input: ["text", "image", "video"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8192,
        },
      ],
    } satisfies ModelProviderConfig;

    expect(normalizeConfig({ provider: "moonshot", providerConfig: configuredProvider })).toBe(
      configuredProvider,
    );
  });
});
