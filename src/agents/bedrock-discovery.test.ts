import type { BedrockClient } from "@aws-sdk/client-bedrock";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
const clientFactory = () => ({ send: sendMock }) as unknown as BedrockClient;

describe("bedrock discovery", () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it("filters to active streaming text models and maps modalities", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

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
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    sendMock.mockResolvedValueOnce({
      modelSummaries: [
        {
          modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
          modelName: "Claude 3.7 Sonnet",
          providerName: "anthropic",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
          responseStreamingSupported: true,
          modelLifecycle: { status: "ACTIVE" },
        },
      ],
    });

    const models = await discoverBedrockModels({
      region: "us-east-1",
      config: { providerFilter: ["amazon"] },
      clientFactory,
    });
    expect(models).toHaveLength(0);
  });

  it("uses configured defaults for context and max tokens", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    sendMock.mockResolvedValueOnce({
      modelSummaries: [
        {
          modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
          modelName: "Claude 3.7 Sonnet",
          providerName: "anthropic",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
          responseStreamingSupported: true,
          modelLifecycle: { status: "ACTIVE" },
        },
      ],
    });

    const models = await discoverBedrockModels({
      region: "us-east-1",
      config: { defaultContextWindow: 64000, defaultMaxTokens: 8192 },
      clientFactory,
    });
    expect(models[0]).toMatchObject({ contextWindow: 64000, maxTokens: 8192 });
  });

  it("caches results when refreshInterval is enabled", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    sendMock.mockResolvedValueOnce({
      modelSummaries: [
        {
          modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
          modelName: "Claude 3.7 Sonnet",
          providerName: "anthropic",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
          responseStreamingSupported: true,
          modelLifecycle: { status: "ACTIVE" },
        },
      ],
    });

    await discoverBedrockModels({ region: "us-east-1", clientFactory });
    await discoverBedrockModels({ region: "us-east-1", clientFactory });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("skips cache when refreshInterval is 0", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    sendMock
      .mockResolvedValueOnce({
        modelSummaries: [
          {
            modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
            modelName: "Claude 3.7 Sonnet",
            providerName: "anthropic",
            inputModalities: ["TEXT"],
            outputModalities: ["TEXT"],
            responseStreamingSupported: true,
            modelLifecycle: { status: "ACTIVE" },
          },
        ],
      })
      .mockResolvedValueOnce({
        modelSummaries: [
          {
            modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
            modelName: "Claude 3.7 Sonnet",
            providerName: "anthropic",
            inputModalities: ["TEXT"],
            outputModalities: ["TEXT"],
            responseStreamingSupported: true,
            modelLifecycle: { status: "ACTIVE" },
          },
        ],
      });

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
});
