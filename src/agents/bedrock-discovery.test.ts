import type { BedrockClient } from "@aws-sdk/client-bedrock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../plugin-sdk/plugin-entry.js";
import type { ProviderPlugin } from "../plugins/types.js";

const sendMock = vi.fn();
const clientFactory = () => ({ send: sendMock }) as unknown as BedrockClient;

const baseActiveAnthropicSummary = {
  modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
  modelName: "Claude 3.7 Sonnet",
  providerName: "anthropic",
  inputModalities: ["TEXT"],
  outputModalities: ["TEXT"],
  responseStreamingSupported: true,
  modelLifecycle: { status: "ACTIVE" },
};

async function loadDiscovery() {
  const mod = await import("../plugin-sdk/amazon-bedrock.js");
  mod.resetBedrockDiscoveryCacheForTest();
  return mod;
}

async function loadBedrockPluginProvider(): Promise<ProviderPlugin> {
  const providers: ProviderPlugin[] = [];
  const { default: entry } = await import("../../extensions/amazon-bedrock/index.js");
  void entry.register({
    registerProvider(provider) {
      providers.push(provider);
    },
  } as Pick<OpenClawPluginApi, "registerProvider"> as OpenClawPluginApi);
  expect(providers).toHaveLength(1);
  return providers[0];
}

function mockSingleActiveSummary(overrides: Partial<typeof baseActiveAnthropicSummary> = {}): void {
  sendMock.mockResolvedValueOnce({
    modelSummaries: [{ ...baseActiveAnthropicSummary, ...overrides }],
  });
}

describe("bedrock discovery", () => {
  beforeEach(() => {
    sendMock.mockClear();
  });

  it("filters to active streaming text models and maps modalities", async () => {
    const { discoverBedrockModels } = await loadDiscovery();

    sendMock.mockResolvedValueOnce({
      modelSummaries: [
        {
          modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
          modelName: "Claude 3.7 Sonnet",
          providerName: "anthropic",
          inputModalities: ["TEXT", "IMAGE"],
          outputModalities: ["TEXT"],
          responseStreamingSupported: true,
          modelLifecycle: { status: "ACTIVE" },
        },
        {
          modelId: "anthropic.claude-3-haiku-20240307-v1:0",
          modelName: "Claude 3 Haiku",
          providerName: "anthropic",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
          responseStreamingSupported: false,
          modelLifecycle: { status: "ACTIVE" },
        },
        {
          modelId: "meta.llama3-8b-instruct-v1:0",
          modelName: "Llama 3 8B",
          providerName: "meta",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
          responseStreamingSupported: true,
          modelLifecycle: { status: "INACTIVE" },
        },
        {
          modelId: "amazon.titan-embed-text-v1",
          modelName: "Titan Embed",
          providerName: "amazon",
          inputModalities: ["TEXT"],
          outputModalities: ["EMBEDDING"],
          responseStreamingSupported: true,
          modelLifecycle: { status: "ACTIVE" },
        },
      ],
    });

    const models = await discoverBedrockModels({ region: "us-east-1", clientFactory });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "anthropic.claude-3-7-sonnet-20250219-v1:0",
      name: "Claude 3.7 Sonnet",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 32000,
      maxTokens: 4096,
    });
  });

  it("applies provider filter", async () => {
    const { discoverBedrockModels } = await loadDiscovery();
    mockSingleActiveSummary();

    const models = await discoverBedrockModels({
      region: "us-east-1",
      config: { providerFilter: ["amazon"] },
      clientFactory,
    });
    expect(models).toHaveLength(0);
  });

  it("uses configured defaults for context and max tokens", async () => {
    const { discoverBedrockModels } = await loadDiscovery();
    mockSingleActiveSummary();

    const models = await discoverBedrockModels({
      region: "us-east-1",
      config: { defaultContextWindow: 64000, defaultMaxTokens: 8192 },
      clientFactory,
    });
    expect(models[0]).toMatchObject({ contextWindow: 64000, maxTokens: 8192 });
  });

  it("caches results when refreshInterval is enabled", async () => {
    const { discoverBedrockModels } = await loadDiscovery();
    mockSingleActiveSummary();

    await discoverBedrockModels({ region: "us-east-1", clientFactory });
    await discoverBedrockModels({ region: "us-east-1", clientFactory });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("skips cache when refreshInterval is 0", async () => {
    const { discoverBedrockModels } = await loadDiscovery();

    sendMock
      .mockResolvedValueOnce({ modelSummaries: [baseActiveAnthropicSummary] })
      .mockResolvedValueOnce({ modelSummaries: [baseActiveAnthropicSummary] });

    await discoverBedrockModels({
      region: "us-east-1",
      config: { refreshInterval: 0 },
      clientFactory,
    });
    await discoverBedrockModels({
      region: "us-east-1",
      config: { refreshInterval: 0 },
      clientFactory,
    });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("resolves the Bedrock config apiKey from AWS auth env vars", async () => {
    const { resolveBedrockConfigApiKey } = await loadDiscovery();

    expect(
      resolveBedrockConfigApiKey({
        AWS_BEARER_TOKEN_BEDROCK: "bearer", // pragma: allowlist secret
        AWS_PROFILE: "default",
      }),
    ).toBe("AWS_BEARER_TOKEN_BEDROCK");

    expect(resolveBedrockConfigApiKey({} as NodeJS.ProcessEnv)).toBe("AWS_PROFILE");
  });

  it("merges implicit Bedrock models into explicit provider overrides", async () => {
    const { mergeImplicitBedrockProvider } = await loadDiscovery();

    expect(
      mergeImplicitBedrockProvider({
        existing: {
          baseUrl: "https://override.example.com",
          headers: { "x-test-header": "1" },
          models: [],
        },
        implicit: {
          baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
          api: "bedrock-converse-stream",
          auth: "aws-sdk",
          models: [
            {
              id: "amazon.nova-micro-v1:0",
              name: "Nova",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1,
              maxTokens: 1,
            },
          ],
        },
      }).models?.map((model) => model.id),
    ).toEqual(["amazon.nova-micro-v1:0"]);
  });

  it("registers implicit Bedrock discovery through the plugin catalog", async () => {
    vi.resetModules();
    const bedrockApi = await import("../../extensions/amazon-bedrock/api.js");
    vi.spyOn(bedrockApi, "resolveImplicitBedrockProvider").mockResolvedValue({
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      api: "bedrock-converse-stream",
      auth: "aws-sdk",
      models: [
        {
          id: "amazon.nova-micro-v1:0",
          name: "Nova Micro",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_000,
          maxTokens: 4096,
        },
      ],
    });
    vi.spyOn(bedrockApi, "mergeImplicitBedrockProvider").mockImplementation(
      ({ existing, implicit }) => ({
        ...implicit,
        ...existing,
        models:
          Array.isArray(existing?.models) && existing.models.length > 0
            ? existing.models
            : implicit.models,
      }),
    );
    const provider = await loadBedrockPluginProvider();

    const result = await provider.catalog?.run({
      config: {
        models: {
          bedrockDiscovery: {
            enabled: true,
          },
          providers: {
            "amazon-bedrock": {
              baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com",
              headers: { "x-test-header": "1" },
              models: [],
            },
          },
        },
      },
      env: {
        AWS_PROFILE: "default",
      } as NodeJS.ProcessEnv,
      resolveProviderApiKey: () => ({ apiKey: undefined, discoveryApiKey: undefined }),
      resolveProviderAuth: () => ({
        apiKey: undefined,
        discoveryApiKey: undefined,
        mode: "none",
        source: "none",
      }),
    });

    expect(result).toMatchObject({
      provider: {
        api: "bedrock-converse-stream",
        auth: "aws-sdk",
        baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com",
        headers: { "x-test-header": "1" },
      },
    });
    expect(
      result && "provider" in result
        ? result.provider.models?.map((model: { id: string }) => model.id)
        : [],
    ).toEqual(["amazon.nova-micro-v1:0"]);
  });
});
