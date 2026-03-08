import {
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
  type BedrockClient,
} from "@aws-sdk/client-bedrock";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    warn: loggerMocks.warn,
  }),
}));

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

const baseInferenceProfileSummary = {
  inferenceProfileId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
  inferenceProfileName: "US Claude 3.5 Sonnet",
  status: "ACTIVE",
};

type DiscoveryFoundationResponse = {
  modelSummaries?: Array<Record<string, unknown>>;
};

type DiscoveryInferenceResponse = {
  inferenceProfileSummaries?: Array<Record<string, unknown>>;
  nextToken?: string;
};

async function loadDiscovery() {
  const mod = await import("./bedrock-discovery.js");
  mod.resetBedrockDiscoveryCacheForTest();
  return mod;
}

function setupDiscoveryResponses(params?: {
  foundation?: DiscoveryFoundationResponse;
  inferencePages?: DiscoveryInferenceResponse[];
  foundationError?: Error;
  inferenceError?: Error;
}): void {
  const inferencePages = params?.inferencePages ?? [{ inferenceProfileSummaries: [] }];
  let inferenceIndex = 0;

  sendMock.mockImplementation(async (command: unknown) => {
    if (command instanceof ListFoundationModelsCommand) {
      if (params?.foundationError) {
        throw params.foundationError;
      }
      return params?.foundation ?? ({ modelSummaries: [] } as DiscoveryFoundationResponse);
    }

    if (command instanceof ListInferenceProfilesCommand) {
      if (params?.inferenceError) {
        throw params.inferenceError;
      }
      const page = inferencePages[inferenceIndex] ?? ({ inferenceProfileSummaries: [] } as const);
      inferenceIndex += 1;
      return page;
    }

    throw new Error(
      `Unexpected command type: ${String((command as { constructor?: { name?: string } })?.constructor?.name)}`,
    );
  });
}

describe("bedrock discovery", () => {
  beforeEach(() => {
    sendMock.mockReset();
    loggerMocks.warn.mockReset();
  });

  it("filters to active streaming text foundation models and maps modalities", async () => {
    const { discoverBedrockModels } = await loadDiscovery();

    setupDiscoveryResponses({
      foundation: {
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
      },
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

  it("includes active inference profiles with pagination", async () => {
    const { discoverBedrockModels } = await loadDiscovery();

    setupDiscoveryResponses({
      foundation: { modelSummaries: [] },
      inferencePages: [
        {
          inferenceProfileSummaries: [
            {
              inferenceProfileId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
              inferenceProfileName: "US Claude 3.5 Sonnet",
              status: "ACTIVE",
            },
            {
              inferenceProfileId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
              inferenceProfileName: "Duplicate profile id",
              status: "ACTIVE",
            },
          ],
          nextToken: "next-page",
        },
        {
          inferenceProfileSummaries: [
            {
              inferenceProfileId: "eu.amazon.nova-lite-v1:0",
              inferenceProfileName: "EU Nova Thinking Lite",
              status: "ACTIVE",
            },
            {
              inferenceProfileId: "us.meta.llama-3-2-11b-instruct-v1:0",
              inferenceProfileName: "US Meta Inactive",
              status: "INACTIVE",
            },
          ],
        },
      ],
    });

    const models = await discoverBedrockModels({ region: "us-east-1", clientFactory });
    expect(models).toHaveLength(2);
    expect(models.map((entry) => entry.id)).toEqual([
      "eu.amazon.nova-lite-v1:0",
      "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    ]);
    expect(models[0]).toMatchObject({
      name: "EU Nova Thinking Lite",
      reasoning: true,
      input: ["text"],
    });
  });

  it("applies provider filter across foundation models and inference profiles", async () => {
    const { discoverBedrockModels } = await loadDiscovery();
    setupDiscoveryResponses({
      foundation: {
        modelSummaries: [
          baseActiveAnthropicSummary,
          {
            ...baseActiveAnthropicSummary,
            modelId: "amazon.nova-micro-v1:0",
            modelName: "Nova Micro",
            providerName: "amazon",
          },
        ],
      },
      inferencePages: [
        {
          inferenceProfileSummaries: [
            baseInferenceProfileSummary,
            {
              inferenceProfileId: "us.amazon.nova-pro-v1:0",
              inferenceProfileName: "US Nova Pro",
              status: "ACTIVE",
            },
          ],
        },
      ],
    });

    const models = await discoverBedrockModels({
      region: "us-east-1",
      config: { providerFilter: ["amazon"] },
      clientFactory,
    });
    expect(models.map((entry) => entry.id)).toEqual([
      "amazon.nova-micro-v1:0",
      "us.amazon.nova-pro-v1:0",
    ]);
  });

  it("matches provider filters for inference profiles with extended location prefixes", async () => {
    const { discoverBedrockModels } = await loadDiscovery();
    setupDiscoveryResponses({
      foundation: { modelSummaries: [] },
      inferencePages: [
        {
          inferenceProfileSummaries: [
            {
              inferenceProfileId: "apac.amazon.nova-lite-v1:0",
              inferenceProfileName: "APAC Nova Lite",
              status: "ACTIVE",
            },
            {
              inferenceProfileId: "us-gov.amazon.nova-pro-v1:0",
              inferenceProfileName: "US Gov Nova Pro",
              status: "ACTIVE",
            },
            {
              inferenceProfileId: "us-gov.anthropic.claude-3-5-sonnet-20241022-v2:0",
              inferenceProfileName: "US Gov Claude",
              status: "ACTIVE",
            },
          ],
        },
      ],
    });

    const models = await discoverBedrockModels({
      region: "us-east-1",
      config: { providerFilter: ["amazon"] },
      clientFactory,
    });
    expect(models.map((entry) => entry.id)).toEqual([
      "apac.amazon.nova-lite-v1:0",
      "us-gov.amazon.nova-pro-v1:0",
    ]);
  });

  it("uses configured defaults for context and max tokens", async () => {
    const { discoverBedrockModels } = await loadDiscovery();
    setupDiscoveryResponses({
      foundation: { modelSummaries: [baseActiveAnthropicSummary] },
    });

    const models = await discoverBedrockModels({
      region: "us-east-1",
      config: { defaultContextWindow: 64000, defaultMaxTokens: 8192 },
      clientFactory,
    });
    expect(models[0]).toMatchObject({ contextWindow: 64000, maxTokens: 8192 });
  });

  it("returns inference profiles when foundation-model discovery fails", async () => {
    const { discoverBedrockModels } = await loadDiscovery();
    setupDiscoveryResponses({
      foundationError: new Error("foundation-model discovery failed"),
      inferencePages: [{ inferenceProfileSummaries: [baseInferenceProfileSummary] }],
    });

    const models = await discoverBedrockModels({
      region: "us-east-1",
      clientFactory,
    });
    expect(models).toEqual([
      expect.objectContaining({
        id: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
      }),
    ]);
  });

  it("logs partial failures when at least one discovery source succeeds", async () => {
    const { discoverBedrockModels } = await loadDiscovery();
    const foundationError = new Error("foundation-model discovery failed");
    setupDiscoveryResponses({
      foundationError,
      inferencePages: [{ inferenceProfileSummaries: [baseInferenceProfileSummary] }],
    });

    const models = await discoverBedrockModels({
      region: "us-east-1",
      clientFactory,
    });

    expect(models).toEqual([
      expect.objectContaining({
        id: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
      }),
    ]);
    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      `Failed to list foundation models during Bedrock discovery: ${String(foundationError)}`,
    );
  });

  it("caches partial discovery results briefly before retrying failed sources", async () => {
    const { discoverBedrockModels } = await loadDiscovery();
    let nowMs = 1_000_000;
    setupDiscoveryResponses({
      foundationError: new Error("foundation-model discovery failed"),
      inferencePages: [
        { inferenceProfileSummaries: [baseInferenceProfileSummary] },
        { inferenceProfileSummaries: [baseInferenceProfileSummary] },
        { inferenceProfileSummaries: [baseInferenceProfileSummary] },
      ],
    });

    await discoverBedrockModels({ region: "us-east-1", clientFactory, now: () => nowMs });
    await discoverBedrockModels({ region: "us-east-1", clientFactory, now: () => nowMs });

    // Partial results are cached for a short TTL to avoid repeated retries/log spam.
    expect(sendMock).toHaveBeenCalledTimes(2);

    nowMs += 59_000;
    await discoverBedrockModels({ region: "us-east-1", clientFactory, now: () => nowMs });
    expect(sendMock).toHaveBeenCalledTimes(2);

    // After short partial-TTL expiry, discovery retries both sources.
    nowMs += 2_000;
    await discoverBedrockModels({ region: "us-east-1", clientFactory, now: () => nowMs });
    expect(sendMock).toHaveBeenCalledTimes(4);
  });

  it("caches results when refreshInterval is enabled", async () => {
    const { discoverBedrockModels } = await loadDiscovery();
    setupDiscoveryResponses({
      foundation: { modelSummaries: [baseActiveAnthropicSummary] },
    });

    await discoverBedrockModels({ region: "us-east-1", clientFactory });
    await discoverBedrockModels({ region: "us-east-1", clientFactory });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("skips cache when refreshInterval is 0", async () => {
    const { discoverBedrockModels } = await loadDiscovery();

    setupDiscoveryResponses({
      foundation: { modelSummaries: [baseActiveAnthropicSummary] },
      inferencePages: [
        { inferenceProfileSummaries: [] },
        { inferenceProfileSummaries: [] },
        { inferenceProfileSummaries: [] },
        { inferenceProfileSummaries: [] },
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
    expect(sendMock).toHaveBeenCalledTimes(4);
  });
});
