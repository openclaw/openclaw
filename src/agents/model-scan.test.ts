import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { scanCommonstackModels, scanOpenRouterModels } from "./model-scan.js";

function createFetchFixture(payload: unknown): typeof fetch {
  return withFetchPreconnect(
    async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("scanOpenRouterModels", () => {
  it("lists free models without probing", async () => {
    const fetchImpl = createFetchFixture({
      data: [
        {
          id: "acme/free-by-pricing",
          name: "Free By Pricing",
          context_length: 16_384,
          max_completion_tokens: 1024,
          supported_parameters: ["tools", "tool_choice", "temperature"],
          modality: "text",
          pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
          created_at: 1_700_000_000,
        },
        {
          id: "acme/free-by-suffix:free",
          name: "Free By Suffix",
          context_length: 8_192,
          supported_parameters: [],
          modality: "text",
          pricing: { prompt: "0", completion: "0" },
        },
        {
          id: "acme/paid",
          name: "Paid",
          context_length: 4_096,
          supported_parameters: ["tools"],
          modality: "text",
          pricing: { prompt: "0.000001", completion: "0.000002" },
        },
      ],
    });

    const results = await scanOpenRouterModels({
      fetchImpl,
      probe: false,
    });

    expect(results.map((entry) => entry.id)).toEqual([
      "acme/free-by-pricing",
      "acme/free-by-suffix:free",
    ]);

    const [byPricing] = results;
    expect(byPricing).toBeTruthy();
    if (!byPricing) {
      throw new Error("Expected pricing-based model result.");
    }
    expect(byPricing.supportsToolsMeta).toBe(true);
    expect(byPricing.supportedParametersCount).toBe(3);
    expect(byPricing.isFree).toBe(true);
    expect(byPricing.tool.skipped).toBe(true);
    expect(byPricing.image.skipped).toBe(true);
  });

  it("requires an API key when probing", async () => {
    const fetchImpl = createFetchFixture({ data: [] });
    await withEnvAsync({ OPENROUTER_API_KEY: undefined }, async () => {
      await expect(
        scanOpenRouterModels({
          fetchImpl,
          probe: true,
          apiKey: "",
        }),
      ).rejects.toThrow(/Missing OpenRouter API key/);
    });
  });
});

describe("scanCommonstackModels", () => {
  it("lists models without probing", async () => {
    const fetchImpl = createFetchFixture({
      code: 0,
      msg: "ok",
      data: {
        models: [
          {
            ID: "ed056bb9-d522-4f18-bf4c-ef31c8603b36",
            name: "GPT OSS 120b",
            model_id: "openai/gpt-oss-120b",
            description: "GPT oss 120b for coding, reasoning, and agentic tasks",
            category: "chat",
            context_length: 400_000,
            function_calling: false,
            supported_parameters: ["temperature", "top_p", "max_tokens", "stop"],
            provider: "OpenAI",
            runtime_params: [
              {
                pricing: {
                  inputTokenUnitCost: "0.05",
                  outputTokenUnitCost: "0.25",
                  cacheCreationInputTokenUnitCost: "0",
                  cacheReadInputTokenUnitCost: "0.125",
                },
              },
            ],
          },
          {
            ID: "abc123",
            name: "Claude Sonnet 4.5 dd",
            model_id: "anthropic/claude-sonnet-4.5-dd",
            context_length: 200_000,
            supported_parameters: ["temperature", "max_tokens", "tools"],
            provider: "Anthropic",
            runtime_params: [
              {
                pricing: {
                  inputTokenUnitCost: "0",
                  outputTokenUnitCost: "0",
                },
              },
            ],
          },
        ],
        total: 2,
      },
    });

    const results = await scanCommonstackModels({
      fetchImpl,
      probe: false,
      apiKey: "sk-test-key",
    });

    expect(results.map((entry) => entry.id)).toEqual([
      "openai/gpt-oss-120b",
      "anthropic/claude-sonnet-4.5-dd",
    ]);

    const [first, second] = results;
    expect(first).toBeTruthy();
    if (!first) {
      throw new Error("Expected first model result.");
    }
    expect(first.provider).toBe("commonstack");
    expect(first.modelRef).toBe("commonstack/openai/gpt-oss-120b");
    expect(first.name).toBe("GPT OSS 120b");
    expect(first.contextLength).toBe(400_000);
    expect(first.supportsToolsMeta).toBe(false);
    expect(first.pricing?.prompt).toBe(0.05);
    expect(first.pricing?.completion).toBe(0.25);
    expect(first.isFree).toBe(false);
    expect(first.tool.skipped).toBe(true);

    expect(second).toBeTruthy();
    if (!second) {
      throw new Error("Expected second model result.");
    }
    expect(second.provider).toBe("commonstack");
    expect(second.isFree).toBe(true);
  });

  it("requires an API key", async () => {
    const fetchImpl = createFetchFixture({ code: 0, data: { models: [], total: 0 } });
    const prev = process.env.COMMONSTACK_API_KEY;
    try {
      delete process.env.COMMONSTACK_API_KEY;
      await expect(scanCommonstackModels({ fetchImpl, apiKey: "" })).rejects.toThrow(
        /Missing CommonStack API key/,
      );
    } finally {
      if (prev === undefined) {
        delete process.env.COMMONSTACK_API_KEY;
      } else {
        process.env.COMMONSTACK_API_KEY = prev;
      }
    }
  });
});
