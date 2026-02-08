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

    sendMock
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({
        inferenceProfileSummaries: [],
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
        inferenceProfileSummaries: [],
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
        inferenceProfileSummaries: [],
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
        inferenceProfileSummaries: [],
      });

    await discoverBedrockModels({ region: "us-east-1", clientFactory });
    await discoverBedrockModels({ region: "us-east-1", clientFactory });
    expect(sendMock).toHaveBeenCalledTimes(2);
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
        inferenceProfileSummaries: [],
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
      })
      .mockResolvedValueOnce({
        inferenceProfileSummaries: [],
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
    expect(sendMock).toHaveBeenCalledTimes(4);
  });

  it("discovers inference profiles for cross-region inference", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    sendMock
      .mockResolvedValueOnce({
        modelSummaries: [
          {
            modelId: "anthropic.claude-3-haiku-20240307-v1:0",
            modelName: "Claude 3 Haiku",
            providerName: "anthropic",
            inputModalities: ["TEXT"],
            outputModalities: ["TEXT"],
            responseStreamingSupported: true,
            modelLifecycle: { status: "ACTIVE" },
          },
          {
            modelId: "anthropic.claude-opus-4-6-v1:0",
            modelName: "Claude Opus 4.6",
            providerName: "anthropic",
            inputModalities: ["TEXT", "IMAGE"],
            outputModalities: ["TEXT"],
            responseStreamingSupported: true,
            modelLifecycle: { status: "ACTIVE" },
          },
        ],
      })
      .mockResolvedValueOnce({
        inferenceProfileSummaries: [
          {
            inferenceProfileId: "us.anthropic.claude-3-haiku-20240307-v1:0",
            inferenceProfileName: "US Anthropic Claude 3 Haiku",
            status: "ACTIVE",
            models: [
              {
                modelArn:
                  "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0",
              },
            ],
          },
          {
            inferenceProfileId: "global.anthropic.claude-opus-4-6-v1",
            inferenceProfileName: "Global Anthropic Claude Opus 4.6",
            status: "ACTIVE",
            models: [
              {
                modelArn:
                  "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-6-v1:0",
              },
            ],
          },
        ],
      });

    const models = await discoverBedrockModels({ region: "us-east-1", clientFactory });
    expect(models).toHaveLength(2); // Only inference profiles (foundation models with profiles are skipped)

    // Check inference profiles inherit capabilities from foundation models
    expect(models.find((m) => m.id === "us.anthropic.claude-3-haiku-20240307-v1:0")).toMatchObject({
      id: "us.anthropic.claude-3-haiku-20240307-v1:0",
      name: "US Anthropic Claude 3 Haiku",
      input: ["text"], // Inherited from foundation model
    });
    expect(models.find((m) => m.id === "global.anthropic.claude-opus-4-6-v1")).toMatchObject({
      id: "global.anthropic.claude-opus-4-6-v1",
      name: "Global Anthropic Claude Opus 4.6",
      input: ["text", "image"], // Inherited from foundation model
    });

    // Foundation models should NOT be included (they have inference profiles)
    expect(models.find((m) => m.id === "anthropic.claude-3-haiku-20240307-v1:0")).toBeUndefined();
    expect(models.find((m) => m.id === "anthropic.claude-opus-4-6-v1:0")).toBeUndefined();
  });

  it("skips inference profiles when includeInferenceProfiles is false", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    sendMock.mockResolvedValueOnce({
      modelSummaries: [
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
      config: { includeInferenceProfiles: false },
      clientFactory,
    });
    expect(models).toHaveLength(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("filters inference profiles by provider", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    sendMock
      .mockResolvedValueOnce({
        modelSummaries: [
          {
            modelId: "anthropic.claude-3-haiku-20240307-v1:0",
            modelName: "Claude 3 Haiku",
            providerName: "Anthropic",
            responseStreamingSupported: true,
            outputModalities: ["TEXT"],
            inputModalities: ["TEXT", "IMAGE"],
            modelLifecycle: { status: "ACTIVE" },
          },
          {
            modelId: "amazon.nova-lite-v1:0",
            modelName: "Nova Lite",
            providerName: "Amazon",
            responseStreamingSupported: true,
            outputModalities: ["TEXT"],
            inputModalities: ["TEXT", "IMAGE"],
            modelLifecycle: { status: "ACTIVE" },
          },
        ],
      })
      .mockResolvedValueOnce({
        inferenceProfileSummaries: [
          {
            inferenceProfileId: "us.anthropic.claude-3-haiku-20240307-v1:0",
            inferenceProfileName: "US Anthropic Claude 3 Haiku",
            status: "ACTIVE",
            models: [
              {
                modelArn:
                  "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0",
              },
            ],
          },
          {
            inferenceProfileId: "us.amazon.nova-lite-v1:0",
            inferenceProfileName: "US Nova Lite",
            status: "ACTIVE",
            models: [
              {
                modelArn: "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0",
              },
            ],
          },
        ],
      });

    const models = await discoverBedrockModels({
      region: "us-east-1",
      config: { providerFilter: ["anthropic"] },
      clientFactory,
    });
    expect(models).toHaveLength(1); // Only inference profile (foundation model is skipped)
    expect(models.find((m) => m.id === "us.anthropic.claude-3-haiku-20240307-v1:0")).toBeDefined();
    // Foundation model should NOT be included (it has an inference profile)
    expect(models.find((m) => m.id === "anthropic.claude-3-haiku-20240307-v1:0")).toBeUndefined();
  });

  it("filters out inference profiles without valid foundation models", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    sendMock
      .mockResolvedValueOnce({
        modelSummaries: [
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
      })
      .mockResolvedValueOnce({
        inferenceProfileSummaries: [
          {
            inferenceProfileId: "us.anthropic.claude-3-haiku-20240307-v1:0",
            inferenceProfileName: "US Anthropic Claude 3 Haiku",
            status: "ACTIVE",
            models: [
              {
                modelArn:
                  "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0",
              },
            ],
          },
          {
            // This profile references a model that doesn't exist in foundation models
            inferenceProfileId: "us.anthropic.claude-nonexistent-v1:0",
            inferenceProfileName: "US Anthropic Nonexistent",
            status: "ACTIVE",
            models: [
              {
                modelArn:
                  "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-nonexistent-v1:0",
              },
            ],
          },
        ],
      });

    const models = await discoverBedrockModels({ region: "us-east-1", clientFactory });
    // Should only include 1 valid inference profile (foundation model is skipped, nonexistent profile filtered out)
    expect(models).toHaveLength(1);
    expect(models.find((m) => m.id === "us.anthropic.claude-3-haiku-20240307-v1:0")).toBeDefined();
    expect(models.find((m) => m.id === "us.anthropic.claude-nonexistent-v1:0")).toBeUndefined();
    // Foundation model should NOT be included (it has an inference profile)
    expect(models.find((m) => m.id === "anthropic.claude-3-haiku-20240307-v1:0")).toBeUndefined();
  });

  it("filters out inference profiles with non-streaming foundation models", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    sendMock
      .mockResolvedValueOnce({
        modelSummaries: [
          {
            modelId: "anthropic.claude-3-haiku-20240307-v1:0",
            modelName: "Claude 3 Haiku",
            providerName: "anthropic",
            inputModalities: ["TEXT"],
            outputModalities: ["TEXT"],
            responseStreamingSupported: false, // No streaming support
            modelLifecycle: { status: "ACTIVE" },
          },
        ],
      })
      .mockResolvedValueOnce({
        inferenceProfileSummaries: [
          {
            inferenceProfileId: "us.anthropic.claude-3-haiku-20240307-v1:0",
            inferenceProfileName: "US Anthropic Claude 3 Haiku",
            status: "ACTIVE",
            models: [
              {
                modelArn:
                  "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0",
              },
            ],
          },
        ],
      });

    const models = await discoverBedrockModels({ region: "us-east-1", clientFactory });
    // Both foundation model and inference profile should be filtered out (no streaming)
    expect(models).toHaveLength(0);
  });

  it("includes foundation models that do not have inference profiles", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    sendMock
      .mockResolvedValueOnce({
        modelSummaries: [
          {
            modelId: "anthropic.claude-3-haiku-20240307-v1:0",
            modelName: "Claude 3 Haiku",
            providerName: "anthropic",
            inputModalities: ["TEXT"],
            outputModalities: ["TEXT"],
            responseStreamingSupported: true,
            modelLifecycle: { status: "ACTIVE" },
          },
          {
            modelId: "cohere.command-r-v1:0",
            modelName: "Cohere Command R",
            providerName: "cohere",
            inputModalities: ["TEXT"],
            outputModalities: ["TEXT"],
            responseStreamingSupported: true,
            modelLifecycle: { status: "ACTIVE" },
          },
        ],
      })
      .mockResolvedValueOnce({
        inferenceProfileSummaries: [
          {
            // Only Claude has an inference profile
            inferenceProfileId: "us.anthropic.claude-3-haiku-20240307-v1:0",
            inferenceProfileName: "US Anthropic Claude 3 Haiku",
            status: "ACTIVE",
            models: [
              {
                modelArn:
                  "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0",
              },
            ],
          },
        ],
      });

    const models = await discoverBedrockModels({ region: "us-east-1", clientFactory });
    // Should include: 1 inference profile (Claude) + 1 foundation model without profile (Cohere)
    expect(models).toHaveLength(2);
    expect(models.find((m) => m.id === "us.anthropic.claude-3-haiku-20240307-v1:0")).toBeDefined();
    expect(models.find((m) => m.id === "cohere.command-r-v1:0")).toBeDefined();
    // Claude foundation model should NOT be included (it has an inference profile)
    expect(models.find((m) => m.id === "anthropic.claude-3-haiku-20240307-v1:0")).toBeUndefined();
  });
});
