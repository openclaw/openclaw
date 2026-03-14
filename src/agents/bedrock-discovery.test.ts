import type { BedrockClient } from "@aws-sdk/client-bedrock";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  const mod = await import("./bedrock-discovery.js");
  mod.resetBedrockDiscoveryCacheForTest();
  return mod;
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

  describe("cost metadata (bedrockDiscovery.costs)", () => {
    it("defaults to zero cost when no costs config is provided", async () => {
      const { discoverBedrockModels } = await loadDiscovery();
      mockSingleActiveSummary();

      const models = await discoverBedrockModels({ region: "us-east-1", clientFactory });
      expect(models[0]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    });

    it("applies cost override for a matching model ID", async () => {
      const { discoverBedrockModels } = await loadDiscovery();
      mockSingleActiveSummary();

      const models = await discoverBedrockModels({
        region: "us-east-1",
        config: {
          costs: {
            "anthropic.claude-3-7-sonnet-20250219-v1:0": {
              input: 3,
              output: 15,
              cacheRead: 0.3,
              cacheWrite: 3.75,
            },
          },
        },
        clientFactory,
      });

      expect(models[0]?.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    });

    it("uses zero cost for a model not present in the costs map", async () => {
      const { discoverBedrockModels } = await loadDiscovery();
      mockSingleActiveSummary();

      const models = await discoverBedrockModels({
        region: "us-east-1",
        config: {
          costs: {
            "some.other.model-id": { input: 1, output: 5 },
          },
        },
        clientFactory,
      });

      expect(models[0]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    });

    it("fills missing cost fields with zero when only partial cost override is given", async () => {
      const { discoverBedrockModels } = await loadDiscovery();
      mockSingleActiveSummary();

      const models = await discoverBedrockModels({
        region: "us-east-1",
        config: {
          costs: {
            "anthropic.claude-3-7-sonnet-20250219-v1:0": { input: 3, output: 15 },
          },
        },
        clientFactory,
      });

      expect(models[0]?.cost).toEqual({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 });
    });

    it("applies cost overrides to multiple discovered models independently", async () => {
      const { discoverBedrockModels } = await loadDiscovery();

      sendMock.mockResolvedValueOnce({
        modelSummaries: [
          baseActiveAnthropicSummary,
          {
            modelId: "anthropic.claude-3-haiku-20240307-v1:0",
            modelName: "Claude 3 Haiku",
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
        config: {
          costs: {
            "anthropic.claude-3-7-sonnet-20250219-v1:0": { input: 3, output: 15 },
            "anthropic.claude-3-haiku-20240307-v1:0": { input: 0.25, output: 1.25 },
          },
        },
        clientFactory,
      });

      const sonnet = models.find((m) => m.id === "anthropic.claude-3-7-sonnet-20250219-v1:0");
      const haiku = models.find((m) => m.id === "anthropic.claude-3-haiku-20240307-v1:0");

      expect(sonnet?.cost).toEqual({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 });
      expect(haiku?.cost).toEqual({ input: 0.25, output: 1.25, cacheRead: 0, cacheWrite: 0 });
    });

    it("treats different costs maps as different cache keys", async () => {
      const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } = await loadDiscovery();
      resetBedrockDiscoveryCacheForTest();

      sendMock
        .mockResolvedValueOnce({ modelSummaries: [baseActiveAnthropicSummary] })
        .mockResolvedValueOnce({ modelSummaries: [baseActiveAnthropicSummary] });

      await discoverBedrockModels({
        region: "us-east-1",
        config: { costs: { "anthropic.claude-3-7-sonnet-20250219-v1:0": { input: 3 } } },
        clientFactory,
      });
      await discoverBedrockModels({
        region: "us-east-1",
        config: { costs: { "anthropic.claude-3-7-sonnet-20250219-v1:0": { input: 5 } } },
        clientFactory,
      });

      // Different costs = different cache keys = two separate API calls
      expect(sendMock).toHaveBeenCalledTimes(2);
    });
  });
});
