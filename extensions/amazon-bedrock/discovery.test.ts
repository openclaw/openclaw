import type { BedrockClient } from "@aws-sdk/client-bedrock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverBedrockModels,
  mergeImplicitBedrockProvider,
  resetBedrockDiscoveryCacheForTest,
  resolveBedrockConfigApiKey,
} from "./api.js";

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

function mockSingleActiveSummary(overrides: Partial<typeof baseActiveAnthropicSummary> = {}): void {
  sendMock.mockResolvedValueOnce({
    modelSummaries: [{ ...baseActiveAnthropicSummary, ...overrides }],
  });
}

describe("bedrock discovery", () => {
  beforeEach(() => {
    sendMock.mockClear();
    resetBedrockDiscoveryCacheForTest();
  });

  it("filters to active streaming text models and maps modalities", async () => {
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
    mockSingleActiveSummary();

    const models = await discoverBedrockModels({
      region: "us-east-1",
      config: { providerFilter: ["amazon"] },
      clientFactory,
    });
    expect(models).toHaveLength(0);
  });

  it("uses configured defaults for context and max tokens", async () => {
    mockSingleActiveSummary();

    const models = await discoverBedrockModels({
      region: "us-east-1",
      config: { defaultContextWindow: 64000, defaultMaxTokens: 8192 },
      clientFactory,
    });
    expect(models[0]).toMatchObject({ contextWindow: 64000, maxTokens: 8192 });
  });

  it("caches results when refreshInterval is enabled", async () => {
    mockSingleActiveSummary();

    await discoverBedrockModels({ region: "us-east-1", clientFactory });
    await discoverBedrockModels({ region: "us-east-1", clientFactory });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("skips cache when refreshInterval is 0", async () => {
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

  it("resolves the Bedrock config apiKey from AWS auth env vars", () => {
    expect(
      resolveBedrockConfigApiKey({
        AWS_BEARER_TOKEN_BEDROCK: "bearer", // pragma: allowlist secret
        AWS_PROFILE: "default",
      }),
    ).toBe("AWS_BEARER_TOKEN_BEDROCK");

    // When no AWS env vars are present (e.g. instance role), no marker should be injected.
    // The aws-sdk credential chain handles auth at request time. (#49891)
    expect(resolveBedrockConfigApiKey({} as NodeJS.ProcessEnv)).toBeUndefined();

    // When AWS_PROFILE is explicitly set, it should return the marker.
    expect(
      resolveBedrockConfigApiKey({ AWS_PROFILE: "default" } as NodeJS.ProcessEnv),
    ).toBe("AWS_PROFILE");
  });

  it("merges implicit Bedrock models into explicit provider overrides", () => {
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
});
