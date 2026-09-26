import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import bedrockMantlePlugin from "./index.js";

describe("amazon-bedrock-mantle provider plugin", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses live plugin config to disable catalog discovery", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected fetch"));
    const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);
    const catalog = provider.catalog;
    if (!catalog) {
      throw new Error("catalog registration missing");
    }

    const result = await catalog.run({
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
      env: {
        AWS_BEARER_TOKEN_BEDROCK: "test-token",
        AWS_REGION: "us-east-1",
      },
    } as never);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns raw discovery for the host to merge with materialized config", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "anthropic.claude-opus-4-7",
              object: "model",
              input_modalities: ["text", "image"],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
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
      env: {
        AWS_BEARER_TOKEN_BEDROCK: "test-token",
        AWS_REGION: "us-east-1",
      },
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
    expect(
      provider.classifyFailoverReason?.({ errorMessage: "rate_limit exceeded" } as never),
    ).toBe("rate_limit");
    expect(
      provider.classifyFailoverReason?.({ errorMessage: "429 Too Many Requests" } as never),
    ).toBe("rate_limit");
    expect(
      provider.classifyFailoverReason?.({ errorMessage: "some other error" } as never),
    ).toBeUndefined();
    expect(provider.classifyFailoverReason?.({ errorMessage: "overloaded_error" } as never)).toBe(
      "overloaded",
    );
  });

  it("provides a custom stream only for Mantle Anthropic models", async () => {
    const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);

    expect(
      typeof provider.createStreamFn?.({
        provider: "amazon-bedrock-mantle",
        modelId: "anthropic.claude-opus-4-7",
        model: {
          api: "anthropic-messages",
        },
      } as never),
    ).toBe("function");

    expect(
      provider.createStreamFn?.({
        provider: "amazon-bedrock-mantle",
        modelId: "openai.gpt-oss-120b",
        model: {
          api: "openai-completions",
        },
      } as never),
    ).toBeUndefined();
  });

  it.each([
    {
      name: "Opus 5",
      id: "claude-opus-5",
      staleCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      expectedCost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    },
    {
      name: "Sonnet 5",
      id: "claude-sonnet-5",
      staleCost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      expectedCost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
  ])(
    "restores missing or stale $name pricing during runtime normalization",
    async ({ name, id, staleCost, expectedCost }) => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.UTC(2026, 8, 1));
      try {
        const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);
        const model = {
          id: `anthropic.${id}`,
          name: `Claude ${name}`,
          api: "anthropic-messages",
          provider: "amazon-bedrock-mantle",
          baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1_000_000,
          maxTokens: 128_000,
          params: { canonicalModelId: id },
        };
        for (const cost of [undefined, staleCost]) {
          const normalized = provider.normalizeResolvedModel?.({
            provider: "amazon-bedrock-mantle",
            modelId: model.id,
            model: { ...model, cost },
          } as never);
          expect(normalized?.cost).toEqual(expectedCost);
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
