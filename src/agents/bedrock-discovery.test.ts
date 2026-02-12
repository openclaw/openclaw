import type { BedrockClient } from "@aws-sdk/client-bedrock";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
const clientFactory = () => ({ send: sendMock }) as unknown as BedrockClient;

/** Helper: queue a foundation-models response followed by an inference-profiles response. */
function mockBedrockResponses(modelSummaries: unknown[], inferenceProfiles: unknown[] = []) {
  sendMock
    .mockResolvedValueOnce({ modelSummaries })
    .mockResolvedValueOnce({ inferenceProfileSummaries: inferenceProfiles });
}

describe("bedrock discovery", () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it("filters to active streaming text models and maps modalities", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    mockBedrockResponses([
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
    ]);

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

    mockBedrockResponses([
      {
        modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
        modelName: "Claude 3.7 Sonnet",
        providerName: "anthropic",
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
        responseStreamingSupported: true,
        modelLifecycle: { status: "ACTIVE" },
      },
    ]);

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

    mockBedrockResponses([
      {
        modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
        modelName: "Claude 3.7 Sonnet",
        providerName: "anthropic",
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
        responseStreamingSupported: true,
        modelLifecycle: { status: "ACTIVE" },
      },
    ]);

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

    mockBedrockResponses([
      {
        modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
        modelName: "Claude 3.7 Sonnet",
        providerName: "anthropic",
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
        responseStreamingSupported: true,
        modelLifecycle: { status: "ACTIVE" },
      },
    ]);

    await discoverBedrockModels({ region: "us-east-1", clientFactory });
    await discoverBedrockModels({ region: "us-east-1", clientFactory });
    // Two sends per discovery (foundation models + inference profiles), but only one discovery call
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("skips cache when refreshInterval is 0", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    mockBedrockResponses([
      {
        modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
        modelName: "Claude 3.7 Sonnet",
        providerName: "anthropic",
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
        responseStreamingSupported: true,
        modelLifecycle: { status: "ACTIVE" },
      },
    ]);
    mockBedrockResponses([
      {
        modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
        modelName: "Claude 3.7 Sonnet",
        providerName: "anthropic",
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
        responseStreamingSupported: true,
        modelLifecycle: { status: "ACTIVE" },
      },
    ]);

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
    // Two discovery calls × 2 sends each = 4
    expect(sendMock).toHaveBeenCalledTimes(4);
  });

  it("prefers inference profile IDs over foundation model IDs", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    mockBedrockResponses(
      [
        {
          modelId: "amazon.nova-2-lite-v1:0",
          modelName: "Amazon Nova 2 Lite",
          providerName: "amazon",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
          responseStreamingSupported: true,
          modelLifecycle: { status: "ACTIVE" },
        },
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
      [
        {
          inferenceProfileId: "us.amazon.nova-2-lite-v1:0",
          inferenceProfileName: "US Amazon Nova 2 Lite",
          inferenceProfileArn:
            "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-2-lite-v1:0",
          status: "ACTIVE",
          type: "SYSTEM_DEFINED",
          models: [{ modelArn: "arn:aws:bedrock:*::foundation-model/amazon.nova-2-lite-v1:0" }],
        },
      ],
    );

    const models = await discoverBedrockModels({ region: "us-east-1", clientFactory });
    expect(models).toHaveLength(2);
    const nova = models.find((m) => m.name === "Amazon Nova 2 Lite");
    const claude = models.find((m) => m.name === "Claude 3.7 Sonnet");
    // Nova should use the inference profile ID
    expect(nova?.id).toBe("us.amazon.nova-2-lite-v1:0");
    // Claude has no inference profile, keeps foundation model ID
    expect(claude?.id).toBe("anthropic.claude-3-7-sonnet-20250219-v1:0");
  });

  it("ignores non-SYSTEM_DEFINED inference profiles", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    mockBedrockResponses(
      [
        {
          modelId: "amazon.nova-2-lite-v1:0",
          modelName: "Amazon Nova 2 Lite",
          providerName: "amazon",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
          responseStreamingSupported: true,
          modelLifecycle: { status: "ACTIVE" },
        },
      ],
      [
        {
          inferenceProfileId: "custom.amazon.nova-2-lite-v1:0",
          inferenceProfileName: "Custom Nova 2 Lite",
          inferenceProfileArn: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/custom",
          status: "ACTIVE",
          type: "APPLICATION",
          models: [{ modelArn: "arn:aws:bedrock:*::foundation-model/amazon.nova-2-lite-v1:0" }],
        },
      ],
    );

    const models = await discoverBedrockModels({ region: "us-east-1", clientFactory });
    expect(models[0]?.id).toBe("amazon.nova-2-lite-v1:0");
  });

  it("ignores inactive inference profiles", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    mockBedrockResponses(
      [
        {
          modelId: "amazon.nova-2-lite-v1:0",
          modelName: "Amazon Nova 2 Lite",
          providerName: "amazon",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
          responseStreamingSupported: true,
          modelLifecycle: { status: "ACTIVE" },
        },
      ],
      [
        {
          inferenceProfileId: "us.amazon.nova-2-lite-v1:0",
          inferenceProfileName: "US Amazon Nova 2 Lite",
          inferenceProfileArn:
            "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-2-lite-v1:0",
          status: "DEPRECATED",
          type: "SYSTEM_DEFINED",
          models: [{ modelArn: "arn:aws:bedrock:*::foundation-model/amazon.nova-2-lite-v1:0" }],
        },
      ],
    );

    const models = await discoverBedrockModels({ region: "us-east-1", clientFactory });
    expect(models[0]?.id).toBe("amazon.nova-2-lite-v1:0");
  });

  it("falls back to foundation model IDs when ListInferenceProfiles fails", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    sendMock
      .mockResolvedValueOnce({
        modelSummaries: [
          {
            modelId: "amazon.nova-2-lite-v1:0",
            modelName: "Amazon Nova 2 Lite",
            providerName: "amazon",
            inputModalities: ["TEXT"],
            outputModalities: ["TEXT"],
            responseStreamingSupported: true,
            modelLifecycle: { status: "ACTIVE" },
          },
        ],
      })
      .mockRejectedValueOnce(new Error("AccessDeniedException"));

    const models = await discoverBedrockModels({ region: "us-east-1", clientFactory });
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("amazon.nova-2-lite-v1:0");
  });
});
