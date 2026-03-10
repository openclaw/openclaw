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
      data: [
        {
          created: 1763447647,
          id: "openai/gpt-oss-120b",
          object: "model",
          owned_by: "OpenAI",
        },
        {
          created: 1770383826,
          id: "anthropic/claude-sonnet-4-5",
          object: "model",
          owned_by: "Anthropic",
        },
      ],
      object: "list",
    });

    const results = await scanCommonstackModels({
      fetchImpl,
      probe: false,
      apiKey: "sk-test-key", // pragma: allowlist secret
    });

    expect(results.map((entry) => entry.id)).toEqual([
      "openai/gpt-oss-120b",
      "anthropic/claude-sonnet-4-5",
    ]);

    const [first, second] = results;
    expect(first).toBeTruthy();
    if (!first) {
      throw new Error("Expected first model result.");
    }
    expect(first.provider).toBe("commonstack");
    expect(first.modelRef).toBe("commonstack/openai/gpt-oss-120b");
    expect(first.name).toBe("openai/gpt-oss-120b");
    expect(first.contextLength).toBeNull();
    expect(first.pricing).toBeNull();
    expect(first.createdAtMs).toBe(1763447647000);
    expect(first.tool.skipped).toBe(true);

    expect(second).toBeTruthy();
    if (!second) {
      throw new Error("Expected second model result.");
    }
    expect(second.provider).toBe("commonstack");
    expect(second.createdAtMs).toBe(1770383826000);
  });

  it("requires an API key", async () => {
    const fetchImpl = createFetchFixture({ data: [], object: "list" });
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
