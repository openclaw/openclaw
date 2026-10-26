import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import bedrockMantlePlugin from "./index.js";

const env = { AWS_BEARER_TOKEN_BEDROCK: "test-token", AWS_REGION: "us-east-1" };

describe("amazon-bedrock-mantle provider plugin", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses live plugin config to disable catalog discovery", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected fetch"));
    const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);
    if (!provider.catalog) {
      throw new Error("catalog registration missing");
    }

    const result = await provider.catalog.run({
      config: {
        plugins: {
          entries: {
            "amazon-bedrock-mantle": {
              config: {
                discovery: { enabled: false },
              },
            },
          },
        },
      },
      env,
    } as never);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns raw discovery for the host to merge with materialized config", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: [
          { id: "anthropic.claude-opus-4-7", object: "model", input_modalities: ["text", "image"] },
        ],
      }),
    );
    const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);

    const result = await provider.catalog?.run({
      config: {
        models: {
          providers: {
            "amazon-bedrock-mantle": {
              baseUrl: "https://explicit.example.test/v1",
              models: [{ id: "anthropic.claude-opus-4-7", input: ["text"] }],
            },
          },
        },
      },
      env,
    } as never);

    if (!result || !("provider" in result)) {
      throw new Error("expected single provider catalog result");
    }
    expect(result.provider.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/v1");
    expect(result.provider.models[0]?.input).toEqual(["text", "image"]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("classifies rate limit errors for failover", async () => {
    const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);
    const classify = (errorMessage: string) =>
      provider.classifyFailoverReason?.({ errorMessage } as never);
    expect(classify("rate_limit exceeded")).toBe("rate_limit");
    expect(classify("429 Too Many Requests")).toBe("rate_limit");
    expect(classify("some other error")).toBeUndefined();
    expect(classify("overloaded_error")).toBe("overloaded");
  });

  it("registers discovered OpenAI GPT models on the Responses route", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: [{ id: "openai.gpt-5.6-luna" }, { id: "openai.gpt-oss-120b" }],
      }),
    );
    const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);
    const result = await provider.catalog?.run({
      config: {},
      env: { ...env, AWS_BEARER_TOKEN_BEDROCK: "test-openai-route-token" },
    } as never);
    if (!result || !("provider" in result)) {
      throw new Error("expected single provider catalog result");
    }
    expect(
      result.provider.models.find((model) => model.id === "openai.gpt-5.6-luna"),
    ).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
    });
    const oss = result.provider.models.find((model) => model.id === "openai.gpt-oss-120b");
    expect(oss?.api ?? result.provider.api).toBe("openai-completions");
    expect(oss).not.toHaveProperty("baseUrl");
  });

  it("provides a custom stream only for Mantle Anthropic models", async () => {
    const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);

    const createStream = (modelId: string, api: string) =>
      provider.createStreamFn?.({
        provider: "amazon-bedrock-mantle",
        modelId,
        model: { api },
      } as never);
    expect(typeof createStream("anthropic.claude-opus-4-7", "anthropic-messages")).toBe("function");
    expect(createStream("openai.gpt-oss-120b", "openai-completions")).toBeUndefined();
  });

  it.each([
    {
      id: "claude-opus-5",
      staleCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      expectedCost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    },
    {
      id: "claude-sonnet-5",
      staleCost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      expectedCost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
  ])(
    "restores missing or stale $id pricing during runtime normalization",
    async ({ id, staleCost, expectedCost }) => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.UTC(2026, 8, 1));
      try {
        const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);
        for (const cost of [undefined, staleCost]) {
          const normalized = provider.normalizeResolvedModel?.({
            provider: "amazon-bedrock-mantle",
            modelId: `anthropic.${id}`,
            model: { params: { canonicalModelId: id }, cost },
          } as never);
          expect(normalized?.cost).toEqual(expectedCost);
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
